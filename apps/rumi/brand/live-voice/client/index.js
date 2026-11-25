/**
 * Live Voice — browser half.
 *
 * WebRTC carries microphone and speaker tracks. The local host negotiates
 * the session and publishes transcript and project-agent events over Fetch.
 */
// bundle marker: 0.9.1
window.__ModuleLoader__.load({
  id: '@rumi/live-voice',
  factory(require) {
    const React = require('react');
    const { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;
    const h = React.createElement;
    // The chat column is not a slot, so the dictation row reaches it through a
    // portal. A host without react-dom keeps the dock placement instead.
    let createPortal = null;
    try {
      createPortal = require('react-dom')?.createPortal ?? null;
    } catch {
      createPortal = null;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const engines = new Set();
        let disposed = false;
        ctx.effect(() => async () => {
          disposed = true;
          await Promise.allSettled([...engines].map(engine => engine.stop()));
          dictation.stop();
        });
        /**
         * Speech as it is decoded, shared by the orb and the dictation strip. The
         * strip shows the words while they arrive; the chat row takes over once a
         * delegation hands the request to the harness.
         */
        const dictation = (() => {
          let state = { active: false, user: '', assistant: '' };
          const listeners = new Set();
          const emit = () => { for (const listener of listeners) listener(); };
          const set = (next) => {
            const merged = { ...state, ...next };
            if (merged.active === state.active && merged.user === state.user && merged.assistant === state.assistant) return;
            state = merged;
            emit();
          };
          return {
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            get: () => state,
            start() { set({ active: true, user: '', assistant: '' }); },
            stop() { set({ active: false, user: '', assistant: '' }); },
            clearUser() { set({ user: '' }); },
            append(role, text) {
              if (typeof text !== 'string' || text === '') return;
              const key = role === 'user' ? 'user' : 'assistant';
              set({ [key]: (state[key] + text).slice(-800) });
            },
          };
        })();

        async function api(path, body, signal) {
          const response = await fetch(`/api/live-voice${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
            cache: 'no-store',
            signal,
          });
          if (response.status === 204) return undefined;
          let payload;
          try {
            payload = await response.json();
          } catch {
            payload = undefined;
          }
          if (!response.ok && !payload?.error) {
            throw new Error(`live voice: ${response.status}`);
          }
          return payload;
        }

        function waitFor(target, type, matches, signal) {
          return new Promise((resolve, reject) => {
            signal.throwIfAborted();
            function cleanup() {
              target.removeEventListener(type, onEvent);
              signal.removeEventListener('abort', onAbort);
            }
            function onEvent(event) {
              if (!matches(event)) return;
              cleanup();
              resolve();
            }
            function onAbort() {
              cleanup();
              reject(signal.reason);
            }
            target.addEventListener(type, onEvent);
            signal.addEventListener('abort', onAbort, { once: true });
          });
        }

        /** One renderer's microphone, WebRTC connection, and host session. */
        function createEngine({ t, onAudio, onStatus, onHandoff, onTranscript, onError, onClosed }) {
          const lifetime = new AbortController();
          let liveId;
          let peer;
          let microphone;
          let playback;
          let negotiation;
          let shutdown;

          async function start(sessionId) {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            if (lifetime.signal.aborted) {
              for (const track of stream.getTracks()) track.stop();
              return;
            }
            [microphone] = stream.getAudioTracks();
            if (!microphone) throw new Error(t('error.microphone'));
            microphone.enabled = false;
            microphone.addEventListener('ended', () => onError(t('error.microphone')), { signal: lifetime.signal });

            peer = new RTCPeerConnection();
            playback = document.createElement('audio');
            peer.addEventListener('track', ({ track }) => {
              playback.srcObject = new MediaStream([track]);
              void playback.play().catch(() => {
                if (!lifetime.signal.aborted) onError(t('error.playback'));
              });
            }, { signal: lifetime.signal });
            peer.addEventListener('connectionstatechange', () => {
              if (peer.connectionState === 'failed') onError(t('error.connection'));
            }, { signal: lifetime.signal });
            peer.addTrack(microphone, stream);
            const events = peer.createDataChannel('oai-events');
            await peer.setLocalDescription(await peer.createOffer());
            lifetime.signal.throwIfAborted();
            if (peer.iceGatheringState !== 'complete') {
              await waitFor(peer, 'icegatheringstatechange', () => peer.iceGatheringState === 'complete',
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]));
            }
            const sdp = peer.localDescription?.sdp;
            if (!sdp) throw new Error(t('error.connection'));

            // Keep the response to a submitted offer so Stop can close a late host session.
            negotiation = api('/session', { sessionId, sdp }, AbortSignal.timeout(35_000)).then(result => {
              if (result?.code === 'voice_busy') throw new Error(t('error.busy'));
              if (result?.error) throw new Error(result.error);
              if (!result?.liveId || !result.sdp) throw new Error(t('error.connection'));
              liveId = result.liveId;
              return result.sdp;
            });
            const answer = await negotiation;
            lifetime.signal.throwIfAborted();
            const ready = waitFor(events, 'message', ({ data }) => {
              try {
                return JSON.parse(data)?.type === 'session.started';
              } catch (error) {
                // Ignore malformed events on the provider data channel.
                return false;
              }
            }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]));
            await Promise.all([ready, peer.setRemoteDescription({ type: 'answer', sdp: answer })]);
            lifetime.signal.throwIfAborted();
            microphone.enabled = true;
            onStatus('listening');
            void poll();
          }

          async function poll() {
            let failures = 0;
            while (!lifetime.signal.aborted) {
              let result;
              try {
                result = await api('/poll', { liveId }, lifetime.signal);
                failures = 0;
              } catch (error) {
                if (lifetime.signal.aborted) return;
                failures += 1;
                if (failures >= 4) {
                  onError(t('error.connection'));
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 800));
                continue;
              }
              if (lifetime.signal.aborted) return;
              for (const event of result?.events ?? []) {
                if (lifetime.signal.aborted) return;
                handle(event);
              }
              if (!lifetime.signal.aborted && result?.closed) {
                void stop('server-closed');
                onClosed('closed');
              }
            }
          }

          function handle(message) {
            if (message.type === 'speaking') {
              onAudio();
            } else if (message.type === 'handoff') {
              onHandoff(message.state);
            } else if (message.type === 'status') {
              onStatus(message.state === 'thinking' ? 'thinking' : 'listening');
            } else if (message.type === 'transcript') {
              onTranscript(message.role, message.text);
            } else if (message.type === 'error') {
              onError(message.message);
            } else if (message.type === 'closed') {
              void stop('server-closed');
              onClosed(message.reason);
            }
          }

          function stop(reason = 'user') {
            if (shutdown) return shutdown;
            lifetime.abort();
            microphone?.stop();
            if (playback) {
              playback.pause();
              playback.srcObject = null;
            }
            shutdown = (async () => {
              try {
                if (negotiation) await Promise.allSettled([negotiation]);
                if (liveId) await api('/close', { liveId, reason }, AbortSignal.timeout(5_000));
              } catch (error) {
                console.warn('Live Voice could not confirm host shutdown', error);
              } finally {
                peer?.close();
                engines.delete(engine);
              }
            })();
            return shutdown;
          }

          function setMuted(muted) {
            if (!lifetime.signal.aborted && microphone) microphone.enabled = !muted;
          }

          const engine = { start, stop, setMuted };
          engines.add(engine);
          return engine;
        }

        const STATUS_TEXT = {
          connecting: 'Connecting',
          listening: 'Listening',
          thinking: 'Working',
          speaking: 'Speaking',
          error: 'Error',
        };

        const STYLE_ID = 'dsh-live-voice-style';

        function ensureStyle() {
          if (document.getElementById(STYLE_ID)) return;
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = `
            .lv-mic {
              display: inline-flex; align-items: center; justify-content: center;
              flex: 0 0 auto; width: 34px; height: 34px; box-sizing: border-box; padding: 0; margin: 0;
              border-radius: 999px; cursor: pointer; user-select: none; white-space: nowrap;
              font-size: 12px; font-weight: 500; line-height: 1;
              background: transparent; color: var(--dsw-alias-label-primary);
              border: 1px solid var(--dsw-alias-border-l3);
            }
            .lv-mic[aria-pressed='true'] {
              background: var(--dsw-alias-label-primary);
              color: var(--dsw-alias-label-primary-foreground);
            }
            .lv-mic:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
            .lv-orb { transition: transform .12s ease, opacity .12s ease; }
            .lv-orb:hover { transform: scale(1.06); }
            .lv-orb:disabled { opacity: .45; cursor: default; transform: none; }
            .lv-bar {
              transform-box: fill-box; transform-origin: center; transform: scaleY(.62);
            }
            .lv-orb-on .lv-bar { animation: lv-pulse 900ms ease-in-out infinite; }
            .lv-orb-connecting circle { transform-origin: center; animation: lv-connect 1s linear infinite; }
            .lv-orb-connecting .lv-bar { opacity: .45; }
            @keyframes lv-connect { to { transform: rotate(360deg); } }
            .lv-orb-thinking .lv-bar { animation-duration: 1600ms; }
            .lv-caret {
              display: inline-block; width: 2px; height: 1.05em; margin-left: 2px;
              vertical-align: text-bottom; background: currentColor; opacity: .5;
              animation: lv-blink 1.1s ease-in-out infinite;
            }
            @keyframes lv-blink {
              0%, 100% { opacity: .25; }
              50% { opacity: 1; }
            }
            @keyframes lv-pulse {
              0%, 100% { transform: scaleY(.35); }
              50% { transform: scaleY(1); }
            }
            @media (prefers-reduced-motion: reduce) {
              .lv-orb-on .lv-bar { animation: none; transform: scaleY(.8); }
              .lv-caret, .lv-orb-connecting circle { animation: none; }
            }
          `;
          document.head.append(style);
          return () => style.remove();
        }

        function LiveVoice({ sessionId, t }) {
          const [status, setStatus] = useState('idle');
          const [handoff, setHandoff] = useState(null);
          const [muted, setMuted] = useState(false);
          const [error, setError] = useState('');
          const engineRef = useRef(null);
          const idleTimer = useRef(null);



          const settle = useCallback(() => {
            clearTimeout(idleTimer.current);
            idleTimer.current = setTimeout(() => {
              setStatus((current) => (current === 'speaking' ? 'listening' : current));
            }, 600);
          }, []);

          const stop = useCallback(async () => {
            clearTimeout(idleTimer.current);
            const engine = engineRef.current;
            engineRef.current = null;
            setStatus('idle');
            setMuted(false);
            dictation.stop();
            await engine?.stop();
          }, []);

          useEffect(() => {
            setHandoff(null);
            setStatus('idle');
            setMuted(false);
            setError('');
            return () => {
              clearTimeout(idleTimer.current);
              const engine = engineRef.current;
              engineRef.current = null;
              dictation.stop();
              void engine?.stop();
            };
          }, [sessionId]);

          const start = useCallback(async () => {
            if (disposed || !sessionId || engineRef.current) return;
            if (engines.size > 0) {
              setError(t('error.busy'));
              return;
            }
            setError('');
            setHandoff(null);
            setStatus('connecting');
            dictation.start();
            const engine = createEngine({
              t,
              onHandoff: next => { if (engineRef.current === engine) { setHandoff(next); if (next === 'accepted') dictation.clearUser(); } },
              onAudio: () => { if (engineRef.current !== engine) return; setStatus('speaking'); settle(); },
              onStatus: (next) => {
                if (engineRef.current !== engine) return;
                setStatus(next);
                if (next === 'thinking') dictation.clearUser();
              },
              onTranscript: (role, text) => { if (engineRef.current !== engine) return; dictation.append(role, text); },
              onError: (message) => {
                if (engineRef.current !== engine) return;
                setError(message);
                setStatus('error');
                dictation.stop();
                const running = engineRef.current;
                engineRef.current = null;
                void running?.stop();
              },
              onClosed: (reason) => {
                if (engineRef.current !== engine) return;
                engineRef.current = null;
                setStatus('idle');
                dictation.stop();
                setError(`live session ended (${reason})`);
              },
            });
            engineRef.current = engine;
            try {
              await engine.start(sessionId);
            } catch (cause) {
              if (engineRef.current !== engine) return;
              setError(cause?.name === 'TimeoutError' ? t('error.connection') : cause instanceof Error ? cause.message : String(cause));
              setStatus('error');
              dictation.stop();
              engineRef.current = null;
              await engine.stop();
            }
          }, [sessionId, settle, t]);

          const active = status !== 'idle' && status !== 'error';
          const connecting = status === 'connecting';
          const enabled = active && !connecting;
          const title = active
            ? 'End live voice session'
            : sessionId ? 'Start live voice session' : 'Open a session first';
          const className = ['lv-orb', enabled ? 'lv-orb-on' : '', connecting ? 'lv-orb-connecting' : '', status === 'thinking' ? 'lv-orb-thinking' : '']
            .filter(Boolean).join(' ');

          return h('div', { className: 'lv-controls', style: { display: 'inline-flex', alignItems: 'center', gap: 12 } },
            handoff ? h('span', { role: 'status', 'data-voice-handoff': handoff, style: { color: 'var(--dsw-alias-label-primary)' } }, t(`handoff.${handoff}`)) : null,
            error ? h('span', {
              role: 'alert',
              title: error,
              style: { fontSize: 11, color: '#ff8a8a', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, error) : null,
            enabled ? h('span', {
              role: 'button',
              tabIndex: 0,
              'aria-label': t(muted ? 'mic.unmute' : 'mic.mute'),
              'aria-pressed': muted,
              title: t(muted ? 'mic.unmute' : 'mic.mute'),
              className: 'lv-mic',
              onClick: () => {
                const next = !muted;
                setMuted(next);
                void engineRef.current?.setMuted(next);
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                const next = !muted;
                setMuted(next);
                void engineRef.current?.setMuted(next);
              },
            }, h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
              h('path', {
                d: 'M6 4a2 2 0 0 1 4 0v4a2 2 0 0 1-4 0V4M4 7v1a4 4 0 0 0 8 0V7M8 12v2M6 14h4',
                stroke: 'currentColor', strokeWidth: 1.3, fill: 'none', strokeLinecap: 'round',
              }),
              muted ? h('line', { x1: 2, y1: 2, x2: 14, y2: 14, stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }) : null)) : null,
            h('span', {
              role: 'button',
              tabIndex: sessionId ? 0 : -1,
              'aria-label': title,
              'aria-pressed': enabled,
              'aria-busy': connecting,
              'data-state': status,
              'aria-disabled': sessionId ? undefined : true,
              title,
              className,
              onClick: () => { if (!sessionId) return; if (active) void stop(); else void start(); },
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                if (!sessionId) return;
                if (active) void stop(); else void start();
              },
              style: {
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 34, height: 34, minWidth: 34, maxWidth: 34, flex: '0 0 auto',
                padding: 0, margin: 0, background: 'transparent', border: 'none',
                boxShadow: 'none', outline: 'none', cursor: sessionId ? 'pointer' : 'default',
                opacity: sessionId ? 1 : 0.45, userSelect: 'none', lineHeight: 0,
              },
            },
            h('svg', {
              width: 34, height: 34, viewBox: '0 0 34 34',
              'aria-hidden': true, style: { display: 'block' },
            },
            h('circle', {
              cx: 17, cy: 17, r: 16.5,
              fill: enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-primary-foreground)',
              stroke: connecting ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l3)',
              strokeWidth: 1, strokeDasharray: connecting ? '8 5' : undefined,
            }),
            [
              [8.675 + 0 * 3.85, 8],
              [8.675 + 1 * 3.85, 14],
              [8.675 + 2 * 3.85, 20],
              [8.675 + 3 * 3.85, 14],
              [8.675 + 4 * 3.85, 8],
            ].map(([x, height], index) => h('rect', {
              key: index,
              className: 'lv-bar',
              x, y: 17 - height / 2, width: 1.25, height, rx: 0.625,
              fill: enabled ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
              style: { animationDelay: `${index * 90}ms` },
            })))));
        }



        const NS = 'live-voice';

        /** The one label this bundle still draws: the source under the dictation. */
        const LABELS = {
          en: { 'error.microphone': 'Check your microphone and try Live Voice again.', 'error.playback': 'Could not play Live Voice audio. Check your sound output and try again.', 'error.connection': 'Could not connect to Live Voice. Check your network and try again.', 'error.busy': 'Live Voice is busy. Try again when it ends.', 'mic.mute': 'Mute microphone', 'mic.unmute': 'Unmute microphone', 'trigger.voice': 'Live Voice', 'handoff.not_sent': 'No action sent yet', 'handoff.received': 'Sending request…', 'handoff.waiting': 'Waiting for your words…', 'handoff.dispatching': 'Sending request…', 'handoff.accepted': 'Request accepted', 'handoff.failed': 'Request not sent. Please try again.' },
          zh: { 'error.microphone': '请检查麦克风，然后重试实时语音。', 'error.playback': '无法播放实时语音。请检查声音输出后重试。', 'error.connection': '无法连接实时语音。请检查网络后重试。', 'error.busy': '实时语音正在使用中，请在当前会话结束后重试', 'mic.mute': '将麦克风静音', 'mic.unmute': '取消麦克风静音', 'trigger.voice': '实时语音', 'handoff.not_sent': '尚未发送操作', 'handoff.received': '正在发送请求…', 'handoff.waiting': '正在等待语音文字…', 'handoff.dispatching': '正在发送请求…', 'handoff.accepted': '请求已接收', 'handoff.failed': '请求未发送，请重试' },
        };

        /**
         * The dock is wider than the conversation column, so the fallback seat
         * pins its row to the conversation's own content width and centres it.
         */
        const CHAT_COLUMN = {
          width: '100%',
          maxWidth: 'var(--dsh-chat-content-width, 748px)',
          marginLeft: 'auto',
          marginRight: 'auto',
          boxSizing: 'border-box',
        };

        /**
         * The dictation bubble borrows the conversation's own user-message chrome
         * — the same surface, radius, type and width cap the chat draws a sent
         * message with — so it reads as that message while it is still being said.
         */
        const DICTATION_BUBBLE = {
          maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)',
          background: 'var(--dsw-specific-bubble, rgba(128, 140, 160, 0.14))',
          color: 'var(--dsw-alias-label-primary, inherit)',
          borderRadius: 'var(--dsw-radius-xl, 18px)',
          padding: '10px 16px',
          fontSize: 'var(--dsh-content-font-size, 14px)',
          lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        };

        function VoiceMark({ size = 14 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 34 34', 'aria-hidden': true, style: { display: 'block' } },
            h('circle', { cx: 17, cy: 17, r: 16, fill: '#ffffff', stroke: 'rgba(0,0,0,0.18)', strokeWidth: 1 }),
            [[8.05, 8], [12.15, 14], [16.25, 20], [20.35, 14], [24.45, 8]].map(([x, height], index) => h('rect', {
              key: index, x, y: 17 - height / 2, width: 1.5, height, rx: 0.75, fill: '#0d0f12',
            })));
        }

        /**
         * The chat column that owns this conversation's messages, resolved from
         * the seat's own hidden node so the lookup never crosses into another
         * Session. Re-resolves when the view under the composer changes.
         */
        function useChatColumn(anchor) {
          const [column, setColumn] = useState(null);

          useEffect(() => {
            const root = anchor.current?.closest('[data-conversation-content]');
            if (!root) return undefined;
            let frame = 0;
            const sync = () => {
              frame = 0;
              setColumn(root.querySelector('[data-chat-flow]'));
            };
            sync();
            const observer = new MutationObserver(() => {
              if (frame === 0) frame = requestAnimationFrame(sync);
            });
            observer.observe(root, { childList: true, subtree: true });
            return () => {
              observer.disconnect();
              if (frame !== 0) cancelAnimationFrame(frame);
            };
          }, [anchor]);

          return column;
        }

        /**
         * Dictation tail: the words as they are decoded, seated at the end of the
         * conversation as the user message being dictated. The bubble is the
         * message; the mark and title beneath it name the source, and the caret
         * inside it keeps the last word in place while more arrives.
         *
         * The row lives in the chat column, before the running indicator while a
         * turn is in flight, so it scrolls with the transcript and clears when the
         * request dispatches, at which point the committed voice row carries the
         * same words. A view without a chat column (a document, a trajectory)
         * keeps it in the dock above the composer.
         */
        function DictationTail({ t }) {
          const view = useSyncExternalStore(dictation.subscribe, dictation.get);
          const anchor = useRef(null);
          const row = useRef(null);
          const column = useChatColumn(anchor);
          const live = view.active && view.user !== '';



          useEffect(() => {
            const node = row.current;
            if (!live || node === null || column === null) return undefined;
            const place = () => {
              const running = column.querySelector(':scope > [data-chat-running]');
              if (node.parentNode !== column || node.nextElementSibling !== running) {
                column.insertBefore(node, running);
              }
            };
            place();
            const observer = new MutationObserver(place);
            observer.observe(column, { childList: true });
            return () => {
              observer.disconnect();
              node.remove();
            };
          }, [column, live]);

          const anchorNode = h('span', { ref: anchor, hidden: true, 'aria-hidden': true });
          if (!live) return anchorNode;

          const content = h('div', {
            ref: row,
            'data-live-voice-dictation': '',
            style: {
              display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
              gap: 5, padding: '2px 0 4px',
            },
          },
          h('div', { style: DICTATION_BUBBLE }, view.user, h('span', { className: 'lv-caret', 'aria-hidden': true })),
          h('div', {
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11.5, lineHeight: '16px', opacity: 0.45,
            },
          }, h(VoiceMark, { size: 12 }), h('span', null, t('trigger.voice'))));

          return h(Fragment, null, anchorNode, column !== null && createPortal !== null
            ? createPortal(content, column)
            : h('div', { style: CHAT_COLUMN }, content));
        }

        function maskKey(key) {
          return key.length <= 12 ? key : `${key.slice(0, 7)}…${key.slice(-4)}`;
        }

        /**
         * The settings card accepts a replacement secret and reads only its status.
         */
        function LiveVoiceSettings({ view }) {
          const [state, setState] = useState(null);
          const [value, setValue] = useState('');
          const [dirty, setDirty] = useState(false);
          const [busy, setBusy] = useState(false);
          const [error, setError] = useState('');
          const [note, setNote] = useState('');

          const load = useCallback(async () => {
            try {
              const response = await fetch('/api/live-voice/settings', { credentials: 'same-origin', cache: 'no-store' });
              const result = await response.json();
              setState(result);
            } catch {
              setState(null);
            }
          }, []);

          useEffect(() => { void load(); }, [load]);

          const save = useCallback(async () => {
            const key = value.trim();
            if (key === '') return;
            setBusy(true);
            setError('');
            setNote('');
            try {
              const response = await fetch('/api/live-voice/settings', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ apiKey: key }),
                credentials: 'same-origin',
              });
              const result = await response.json();
              if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
              setState(result);
              setValue('');
              setDirty(false);
              setNote('Saved. The next live session uses it.');
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }, [value]);

          if (view === 'summary') {
            return h('span', null, state?.hasKey ? `API key ${state.hint}` : 'No OpenAI API key yet');
          }

          return h('div', { style: { display: 'grid', gap: 8, padding: '4px 0 12px' } },
            h('div', { style: { fontSize: 12, opacity: 0.75 } },
              state === null
                ? 'Reading the stored key…'
                : state.hasKey
                  ? `Stored key ${state.hint} · ${state.file}`
                  : 'No key stored. Paste an OpenAI key with GPT-Live access.'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                type: 'password',
                value,
                placeholder: 'sk-...',
                autoComplete: 'off',
                spellCheck: false,
                disabled: busy,
                onChange: (event) => { setDirty(true); setValue(event.target.value); },
                onKeyDown: (event) => { if (event.key === 'Enter') void save(); },
                style: {
                  flex: '1 1 280px', height: 30, padding: '0 10px', borderRadius: 8,
                  border: '1px solid rgba(128, 140, 160, 0.4)', background: 'transparent',
                  color: 'inherit', fontFamily: 'monospace', fontSize: 12,
                },
              }),
              h('button', {
                type: 'button',
                disabled: busy || value.trim() === '',
                onClick: () => { void save(); },
                style: {
                  height: 30, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid rgba(122, 208, 255, 0.45)', background: 'rgba(122, 208, 255, 0.12)',
                  color: 'inherit', fontSize: 12, opacity: busy ? 0.6 : 1,
                },
              }, busy ? 'Saving…' : 'Save key')),
            error ? h('div', { style: { fontSize: 11, color: '#ff8a8a' } }, error) : null,
            note ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, note) : null);
        }

        ctx.effect(ensureStyle);
        ctx.effect(() => ctx.locale.register(NS, LABELS));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'live-voice-dictation',
          order: 30,
          locale: NS,
        }, DictationTail));
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'live-voice',
          order: 20,
          locale: NS,
        }, LiveVoice));
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@rumi/live-voice',
          locale: NS,
        }, LiveVoiceSettings));
      },
    };
  },
});
