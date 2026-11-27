/**
 * One live voice session entry: GPT-Live WebSocket sideband, delegation bridge,
 * project-context forwarding, idle/cap timers, and browser poll queue.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createVoiceJournal } from './journal.js';
import { conversationContext, conversationText, contextChunks } from './context.js';
import { createVoiceDispatcher } from './dispatch.js';
import { createVoiceMessages } from './messages.js';
import { LiveBridge } from './bridge.js';
import { LiveClient } from './live-client.js';
import { DEFAULT_MODEL, DEFAULT_VOICE, LIVE_ENDPOINT } from './protocol.js';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;

/** Allow a pending voice reply to start and leave time for buffered audio to play. */
const VOICE_REPLY_GRACE_MS = 5_000;

/** Report audible output while ignoring silence reflected by the sideband. */
function hasSpeechAudio(delta) {
  if (typeof delta !== 'string' || delta === '') return false;
  const pcm = Buffer.from(delta, 'base64');
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= 256) return true;
  }
  return false;
}

/**
 * Derive a display label and category for an emitted badge award without
 * duplicating another plugin's badge catalog.
 */
function normalizeAward(award) {
  if (!award || typeof award !== 'object') return null;
  const label = typeof award.label === 'string' && award.label.trim() !== ''
    ? award.label.trim()
    : typeof award.kind === 'string' && award.kind.trim() !== ''
      ? award.kind.trim().replace(/-/g, ' ').replace(/^[a-z]/, letter => letter.toUpperCase())
      : null;
  if (!label) return null;
  const isHabit = award.category === 'habit'
    || (award.category === undefined && (award.path === 'practice' || award.path === 'growth'));
  return { award, name: label, isHabit };
}

/** Build the silent thinking-channel note for newly earned badges in the active project. */
export function formatBadgeNote(awards) {
  const named = awards.map(normalizeAward).filter(Boolean);
  if (named.length === 0) return null;
  const single = named.length === 1 ? named[0] : null;
  const awardNote = single
    ? single.isHabit
      ? (single.award.path === 'growth'
        ? `The user just earned a ${single.name} badge for improving in this project.`
        : `The user just earned a ${single.name} badge in this project.`)
      : `The user just earned the ${single.name} badge in this project.`
    : `The user just earned these badges in this project. ${named.map(entry => entry.name).join(', ')}.`;
  const hasMechanical = named.some(entry => !entry.isHabit);
  const caveat = hasMechanical ? ' Print readiness requires a separate check.' : '';
  return `${awardNote} You may mention this briefly in your next relevant reply, in the user's language. Wait for a normal chance to speak.${caveat}`;
}

/**
 * Create one live session: the GPT-Live sideband, the bridge, and the event
 * queue the browser polls.
 */
export async function createEntry({
  ctx, registry, config, logger, apiKey, sdp, sessionId, liveId, instructions,
  session, agent, signal, onClosed, expandHome, debugLog, readOutcome,
}) {
  const endpoint = new URL(config.endpoint ?? LIVE_ENDPOINT);
  const model = config.model ?? DEFAULT_MODEL;
  const journal = createVoiceJournal(
    expandHome(config.diagnosticsDirectory ?? join(homedir(), '.rumi', 'voice-logs')),
    { sessionId, liveId },
    error => {
      push({ type: 'error', message: `Voice diagnostics could not be saved: ${error.message}` });
      end('diagnostics_failed');
    },
  );
  const queue = [];
  let waiter = null;
  let isClosed = false;
  let lastSpeakingAt = -Infinity;
  let cap;
  let idleTimer;
  const idleTimeoutMs = (config.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60_000;
  let lastUserActivityAt = Date.now();
  let voiceReplyUntil = 0;
  let agentRunning = agent.status === 'running';
  let stopStatus = () => {};
  const turns = new Set();
  let stopContext = () => {};
  const pendingContext = [];

  const push = (message) => {
    queue.push(message);
    waiter?.();
    waiter = null;
  };

  const scheduleIdleClose = () => {
    clearTimeout(idleTimer);
    if (isClosed || agentRunning || turns.size > 0 || bridge.busy || bridge.snapshot().waitingForTranscript) return;
    const deadline = Math.max(lastUserActivityAt + idleTimeoutMs, voiceReplyUntil);
    idleTimer = setTimeout(() => end('idle_timeout'), Math.max(0, deadline - Date.now()));
    idleTimer.unref?.();
  };

  const noteUserActivity = () => {
    lastUserActivityAt = Date.now();
    scheduleIdleClose();
  };

  const allowVoiceReply = () => {
    voiceReplyUntil = Date.now() + VOICE_REPLY_GRACE_MS;
    scheduleIdleClose();
  };

  const handoff = (delegationId, state, detail = null) => {
    journal.record('handoff', { delegationId, state, detail });
    if (!isClosed) push({ type: 'handoff', delegationId, state });
    scheduleIdleClose();
  };

  let speechContext = null;
  const speechLifetime = new AbortController();
  const submit = createVoiceDispatcher({
    resolveAgent: async () => {
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) throw new Error(resolved.error?.message ?? 'session unavailable');
      return resolved.agent;
    },
    createMessages: createVoiceMessages,
    timeoutMs: config.handoffTimeoutMs ?? 10000,
    accepted: delegationId => {
      handoff(delegationId, 'accepted');
      const content = 'The modeling assistant has accepted the request into its inbox. Work is not yet complete. Do not claim a highlight is visible until the viewer reports rendered.';
      journal.record('host.thinking', { delegationId, content });
      live.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
    },
    failed: (delegationId, detail) => handoff(delegationId, 'failed', detail),
    flush: target => ctx.sessions.flush(target),
    outcome: readOutcome,
    finished: result => bridge.turnFinished(result),
    closed: () => bridge.closed,
  });

  const dispatch = task => {
    const content = speechContext ?? Promise.resolve([]);
    speechContext = null;
    const turn = submit({ ...task, content });
    turns.add(turn);
    scheduleIdleClose();
    void turn.then(() => { turns.delete(turn); scheduleIdleClose(); });
  };

  const bridge = new LiveBridge({
    dispatch,
    steer: dispatch,
    transcriptWaitMs: config.transcriptWaitMs ?? 5000,
    state: handoff,
    commentary: (delegationId, content) => {
      journal.record('host.commentary', { delegationId, content });
      live.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: delegationId, content });
      push({ type: 'transcript', role: 'assistant', text: content });
      allowVoiceReply();
    },
    thinking: (delegationId, content) => {
      journal.record('host.thinking', { delegationId, content });
      live.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
    },
    log: (message) => logger.info(message),
  });

  const live = new LiveClient({
    apiKey,
    endpoint: endpoint.href,
    model,
    voice: config.voice ?? DEFAULT_VOICE,
    acknowledgementDelayMs: config.acknowledgementDelayMs ?? 800,
    instructions: `${instructions}\n\n${conversationContext(session, config.contextMaxCharacters ?? 16_000)}`,
    onEvent: (event) => {
      if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
        journal.record(event.type, { delta: event.delta, start_ms: event.start_ms ?? null, end_ms: event.end_ms ?? null });
      } else if (event.type === 'session.delegation.created') {
        journal.record(event.type, { id: event.delegation?.id ?? null, target: event.delegation?.target ?? null, offset_ms: event.offset_ms ?? null });
      } else if (event.type === 'session.thinking.appended') {
        journal.record(event.type, { client_event_id: event.client_event_id ?? null });
      }

      if (event.type === 'session.output_audio.delta') {
        // Keep the speaking indicator responsive without polling for every media frame.
        const now = Date.now();
        if (now - lastSpeakingAt >= 250 && hasSpeechAudio(event.delta)) {
          lastSpeakingAt = now;
          allowVoiceReply();
          push({ type: 'speaking' });
        }
      } else if (event.type === 'session.input_transcript.delta') {
        if (typeof event.delta === 'string' && event.delta.trim()) noteUserActivity();
        if (!speechContext && typeof event.delta === 'string' && event.delta.trim()) {
          if (!bridge.busy && !bridge.snapshot().waitingForTranscript) handoff(null, 'not_sent');
          const requestedAt = new Date().toISOString();
          speechContext = Promise.all(registry.contributors().map(async contributor => {
            if (!contributor.captureRequest) return [];
            try { return await contributor.captureRequest({ sessionId, requestedAt, signal: speechLifetime.signal }); }
            catch (_captureFailed) {
              logger.warn(`Voice reference capture failed: ${contributor.id}`);
              return [{ type: 'text', text: 'The visual reference for this spoken request could not be captured. Ask for a fresh pointing reference; do not guess.' }];
            }
          })).then(parts => parts.flat());
        }
        push({ type: 'transcript', role: 'user', text: event.delta });
      } else if (event.type === 'session.output_transcript.delta') {
        push({ type: 'transcript', role: 'assistant', text: event.delta });
      } else if (event.type === 'session.closed') {
        debugLog(config, `session-closed reason=${event.reason}`);
        end(event.reason ?? 'server_closed');
      } else if (event.type === 'error') {
        journal.record('transport.error', { code: event.error?.code ?? null, message: event.error?.message ?? 'live error' });
        push({ type: 'error', message: event.error?.message ?? 'live error' });
      }
      bridge.handleLiveEvent(event);
      if (event.type === 'session.delegation.created') scheduleIdleClose();
    },
    onClose: (detail) => {
      end('socket_closed');
      debugLog(config, `socket-closed code=${detail?.code ?? '-'} reason=${detail?.reason || '-'}`);
    },
    onError: (error) => {
      journal.record('transport.error', { message: error.message });
      push({ type: 'error', message: error.message });
    },
  });

  const end = (reason, notifyHost = true) => {
    if (isClosed) return;
    isClosed = true;
    journal.record('closed', { reason });
    journal.close();
    bridge.close();
    speechLifetime.abort();
    stopContext();
    stopStatus();
    clearTimeout(idleTimer);
    pendingContext.length = 0;
    clearTimeout(cap);
    signal.removeEventListener('abort', abort);
    void live.close();
    push({ type: 'closed', reason });
    if (notifyHost) onClosed();
  };
  const abort = () => end('plugin_disposed');

  // Subscribe in the same synchronous acquisition as the history snapshot so no
  // committed messages are lost during negotiation.
  stopContext = ctx.on('session/event', (changed, event) => {
    if (isClosed || changed.id !== sessionId) return;
    const message = event.type === 'user/message' ? event.data
      : event.type === 'assistant/message' ? event.data.message : null;
    if (message === null) return;
    if (event.type === 'user/message' && event.data.source.kind === 'user') noteUserActivity();
    if (bridge.busy) return;
    for (const content of contextChunks(conversationText(message))) {
      const frame = { type: 'session.thinking.append', delegation_id: null, content };
      if (live.open) live.send(frame);
      else pendingContext.push(frame);
    }
  });
  stopStatus = ctx.on('api-session/status', (changedId, running) => {
    if (changedId !== sessionId || isClosed) return;
    agentRunning = running;
    scheduleIdleClose();
  });
  signal.addEventListener('abort', abort, { once: true });

  let answer;
  try {
    signal.throwIfAborted();
    journal.record('opened', { model });
    if (isClosed) throw new Error('Voice diagnostics could not be saved');
    answer = await live.connect(sdp, signal);
    signal.throwIfAborted();
    if (isClosed) throw new Error('live voice: session closed during startup');
  } catch (error) {
    end('start_failed');
    await live.close();
    throw error;
  }
  for (const frame of pendingContext.splice(0)) live.send(frame);
  push({ type: 'ready', model });

  cap = setTimeout(() => end('max_session_minutes'), (config.maxSessionMinutes ?? 60) * 60_000);
  cap.unref?.();
  noteUserActivity();

  return {
    get closed() { return isClosed; },
    answer,
    noteBadges(scope, projectPath, awards) {
      if (isClosed || !live.open) return;
      let root;
      try { root = scope.rootFor(session); }
      catch (_unregisteredSession) {
        // Voice can be open while its project is removed or its chat is detached.
        return;
      }
      if (root !== projectPath) return;
      const content = formatBadgeNote(awards);
      if (!content) return;
      const eventId = randomUUID();
      journal.record('host.thinking', { delegationId: null, eventId, awardIds: awards.map(award => award.id), content });
      if (!isClosed) live.send({ type: 'session.thinking.append', event_id: eventId, delegation_id: null, content });
    },
    closeTransport() {
      end('close_requested', false);
      return live.close();
    },
    drain() {
      return Promise.allSettled([...turns]);
    },
    /** Return everything queued, waiting up to `timeoutMs` for the first item. */
    async poll(timeoutMs) {
      if (queue.length === 0 && !isClosed) {
        await new Promise((resolve) => {
          const timer = setTimeout(finish, timeoutMs);
          timer.unref?.();
          function finish() {
            clearTimeout(timer);
            if (waiter === finish) waiter = null;
            resolve();
          }
          waiter = finish;
        });
      }
      const events = queue.splice(0, queue.length);
      return { events, closed: isClosed };
    },
  };
}
