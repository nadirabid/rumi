/** Browser WebRTC session engine and live dictation transcript store. */
import type { Translate } from './locales.ts'

export interface DictationState {
  active: boolean
  user: string
  assistant: string
}

export interface DictationStore {
  subscribe(listener: () => void): () => void
  get(): DictationState
  start(): void
  stop(): void
  clearUser(): void
  append(role: string, text: string): void
}

/**
 * Speech as it is decoded, shared by the orb and the dictation strip. The strip
 * shows the words while they arrive; the chat row takes over once a delegation
 * hands the request to the harness.
 */
export function createDictationStore(): DictationStore {
  let state: DictationState = { active: false, user: '', assistant: '' }
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const set = (next: Partial<DictationState>) => {
    const merged = { ...state, ...next }
    if (merged.active === state.active && merged.user === state.user && merged.assistant === state.assistant) return
    state = merged
    emit()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => state,
    start() { set({ active: true, user: '', assistant: '' }) },
    stop() { set({ active: false, user: '', assistant: '' }) },
    clearUser() { set({ user: '' }) },
    append(role, text) {
      if (typeof text !== 'string' || text === '') return
      const key = role === 'user' ? 'user' : 'assistant'
      set({ [key]: (state[key] + text).slice(-800) })
    },
  }
}

async function api(path: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/live-voice${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (response.status === 204) return undefined
  let payload: any
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok && !payload?.error) throw new Error(`live voice: ${response.status}`)
  return payload
}

function waitFor(target: EventTarget, type: string, matches: (event: any) => boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    function cleanup() {
      target.removeEventListener(type, onEvent)
      signal.removeEventListener('abort', onAbort)
    }
    function onEvent(event: Event) {
      if (!matches(event)) return
      cleanup()
      resolve()
    }
    function onAbort() {
      cleanup()
      reject(signal.reason)
    }
    target.addEventListener(type, onEvent)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface VoiceEngine {
  start(sessionId: string): Promise<void>
  stop(reason?: string): Promise<void>
  setMuted(muted: boolean): void
}

export interface EngineCallbacks {
  t: Translate
  onAudio: () => void
  onStatus: (status: string) => void
  onHandoff: (state: string) => void
  onTranscript: (role: string, text: string) => void
  onError: (message: string) => void
  onClosed: (reason: string) => void
}

/** One renderer's microphone, WebRTC connection, and host session. */
export function createEngine(
  engines: Set<VoiceEngine>,
  { t, onAudio, onStatus, onHandoff, onTranscript, onError, onClosed }: EngineCallbacks,
): VoiceEngine {
  const lifetime = new AbortController()
  let liveId: string | undefined
  let peer: RTCPeerConnection | undefined
  let microphone: MediaStreamTrack | undefined
  let playback: HTMLAudioElement | undefined
  let negotiation: Promise<string> | undefined
  let shutdown: Promise<void> | undefined

  async function start(sessionId: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (lifetime.signal.aborted) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    ;[microphone] = stream.getAudioTracks()
    if (!microphone) throw new Error(t('error.microphone'))
    microphone.enabled = false
    microphone.addEventListener('ended', () => onError(t('error.microphone')), { signal: lifetime.signal })

    peer = new RTCPeerConnection()
    playback = document.createElement('audio')
    peer.addEventListener('track', ({ track }) => {
      playback!.srcObject = new MediaStream([track])
      void playback!.play().catch(() => {
        if (!lifetime.signal.aborted) onError(t('error.playback'))
      })
    }, { signal: lifetime.signal })
    peer.addEventListener('connectionstatechange', () => {
      if (peer?.connectionState === 'failed') onError(t('error.connection'))
    }, { signal: lifetime.signal })
    peer.addTrack(microphone, stream)
    const events = peer.createDataChannel('oai-events')
    await peer.setLocalDescription(await peer.createOffer())
    lifetime.signal.throwIfAborted()
    if (peer.iceGatheringState !== 'complete') {
      await waitFor(
        peer,
        'icegatheringstatechange',
        () => peer!.iceGatheringState === 'complete',
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
      )
    }
    const sdp = peer.localDescription?.sdp
    if (!sdp) throw new Error(t('error.connection'))

    // Keep the response to a submitted offer so Stop can close a late host session.
    negotiation = api('/session', { sessionId, sdp }, AbortSignal.timeout(35_000)).then(result => {
      if (result?.code === 'voice_busy') throw new Error(t('error.busy'))
      if (result?.error) throw new Error(result.error)
      if (!result?.liveId || !result.sdp) throw new Error(t('error.connection'))
      liveId = result.liveId
      return result.sdp as string
    })
    const answer = await negotiation
    lifetime.signal.throwIfAborted()
    const ready = waitFor(events, 'message', ({ data }: MessageEvent) => {
      try {
        return JSON.parse(data)?.type === 'session.started'
      } catch (_malformed) {
        // Ignore malformed events on the provider data channel.
        return false
      }
    }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]))
    await Promise.all([ready, peer.setRemoteDescription({ type: 'answer', sdp: answer })])
    lifetime.signal.throwIfAborted()
    microphone.enabled = true
    onStatus('listening')
    void poll()
  }

  async function poll() {
    let failures = 0
    while (!lifetime.signal.aborted) {
      let result: any
      try {
        result = await api('/poll', { liveId }, lifetime.signal)
        failures = 0
      } catch {
        if (lifetime.signal.aborted) return
        failures += 1
        if (failures >= 4) {
          onError(t('error.connection'))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 800))
        continue
      }
      if (lifetime.signal.aborted) return
      for (const event of result?.events ?? []) {
        if (lifetime.signal.aborted) return
        handle(event)
      }
      if (!lifetime.signal.aborted && result?.closed) {
        void stop('server-closed')
        onClosed('closed')
      }
    }
  }

  function handle(message: any) {
    if (message.type === 'speaking') {
      onAudio()
    } else if (message.type === 'handoff') {
      onHandoff(message.state)
    } else if (message.type === 'status') {
      onStatus(message.state === 'thinking' ? 'thinking' : 'listening')
    } else if (message.type === 'transcript') {
      onTranscript(message.role, message.text)
    } else if (message.type === 'error') {
      onError(message.message)
    } else if (message.type === 'closed') {
      void stop('server-closed')
      onClosed(message.reason)
    }
  }

  function stop(reason = 'user') {
    if (shutdown) return shutdown
    lifetime.abort()
    microphone?.stop()
    if (playback) {
      playback.pause()
      playback.srcObject = null
    }
    shutdown = (async () => {
      try {
        if (negotiation) await Promise.allSettled([negotiation])
        if (liveId) await api('/close', { liveId, reason }, AbortSignal.timeout(5_000))
      } catch (error) {
        console.warn('Live Voice could not confirm host shutdown', error)
      } finally {
        peer?.close()
        engines.delete(engine)
      }
    })()
    return shutdown
  }

  function setMuted(muted: boolean) {
    if (!lifetime.signal.aborted && microphone) microphone.enabled = !muted
  }

  const engine: VoiceEngine = { start, stop, setMuted }
  engines.add(engine)
  return engine
}
