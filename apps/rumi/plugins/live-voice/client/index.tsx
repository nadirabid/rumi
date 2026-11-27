/**
 * Live Voice — browser half.
 *
 * WebRTC carries microphone and speaker tracks. The local host negotiates
 * the session and publishes transcript and project-agent events over Fetch.
 */
import * as React from 'react'
import './styles.css'
import { LABELS, NS, type Translate } from './locales.ts'
import { createDictationStore, createEngine, type VoiceEngine } from './rtc.ts'
import { createDictationTail } from './dictation.tsx'
import { LiveVoiceSettings } from './settings.tsx'

export const inject = ['slots', 'locale']

const ORB_BARS: [number, number][] = [
  [8.675 + 0 * 3.85, 8],
  [8.675 + 1 * 3.85, 14],
  [8.675 + 2 * 3.85, 20],
  [8.675 + 3 * 3.85, 14],
  [8.675 + 4 * 3.85, 8],
]

export function apply(ctx: any) {
  const engines = new Set<VoiceEngine>()
  const dictation = createDictationStore()
  let disposed = false

  ctx.effect(() => async () => {
    disposed = true
    await Promise.allSettled([...engines].map(engine => engine.stop()))
    dictation.stop()
  })

  function LiveVoice({ sessionId, t }: { sessionId?: string; t: Translate }) {
    const [status, setStatus] = React.useState('idle')
    const [handoff, setHandoff] = React.useState<string | null>(null)
    const [muted, setMuted] = React.useState(false)
    const [error, setError] = React.useState('')
    const engineRef = React.useRef<VoiceEngine | null>(null)
    const idleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

    const settle = React.useCallback(() => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = setTimeout(() => {
        setStatus((current) => (current === 'speaking' ? 'listening' : current))
      }, 600)
    }, [])

    const stop = React.useCallback(async () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      const engine = engineRef.current
      engineRef.current = null
      setStatus('idle')
      setMuted(false)
      dictation.stop()
      await engine?.stop()
    }, [])

    React.useEffect(() => {
      setHandoff(null)
      setStatus('idle')
      setMuted(false)
      setError('')
      return () => {
        if (idleTimer.current) clearTimeout(idleTimer.current)
        const engine = engineRef.current
        engineRef.current = null
        dictation.stop()
        void engine?.stop()
      }
    }, [sessionId])

    const start = React.useCallback(async () => {
      if (disposed || !sessionId || engineRef.current) return
      if (engines.size > 0) {
        setError(t('error.busy'))
        return
      }
      setError('')
      setHandoff(null)
      setStatus('connecting')
      dictation.start()
      const engine = createEngine(engines, {
        t,
        onHandoff: next => {
          if (engineRef.current !== engine) return
          setHandoff(next)
          if (next === 'accepted') dictation.clearUser()
        },
        onAudio: () => {
          if (engineRef.current !== engine) return
          setStatus('speaking')
          settle()
        },
        onStatus: (next) => {
          if (engineRef.current !== engine) return
          setStatus(next)
          if (next === 'thinking') dictation.clearUser()
        },
        onTranscript: (role, text) => {
          if (engineRef.current !== engine) return
          dictation.append(role, text)
        },
        onError: (message) => {
          if (engineRef.current !== engine) return
          setError(message)
          setStatus('error')
          dictation.stop()
          const running = engineRef.current
          engineRef.current = null
          void running?.stop()
        },
        onClosed: (reason) => {
          if (engineRef.current !== engine) return
          engineRef.current = null
          setStatus('idle')
          dictation.stop()
          setError(`live session ended (${reason})`)
        },
      })
      engineRef.current = engine
      try {
        await engine.start(sessionId)
      } catch (cause: any) {
        if (engineRef.current !== engine) return
        setError(cause?.name === 'TimeoutError' ? t('error.connection') : cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
        dictation.stop()
        engineRef.current = null
        await engine.stop()
      }
    }, [sessionId, settle, t])

    const toggleMute = () => {
      const next = !muted
      setMuted(next)
      void engineRef.current?.setMuted(next)
    }

    const active = status !== 'idle' && status !== 'error'
    const connecting = status === 'connecting'
    const enabled = active && !connecting
    const title = active
      ? 'End live voice session'
      : sessionId ? 'Start live voice session' : 'Open a session first'
    const className = ['lv-orb', enabled ? 'lv-orb-on' : '', connecting ? 'lv-orb-connecting' : '', status === 'thinking' ? 'lv-orb-thinking' : '']
      .filter(Boolean).join(' ')

    return (
      <div className="lv-controls" style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
        {handoff ? (
          <span role="status" data-voice-handoff={handoff} style={{ color: 'var(--dsw-alias-label-primary)' }}>
            {t(`handoff.${handoff}`)}
          </span>
        ) : null}
        {error ? (
          <span
            role="alert"
            title={error}
            style={{
              fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', maxWidth: 240,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {error}
          </span>
        ) : null}
        {enabled ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={t(muted ? 'mic.unmute' : 'mic.mute')}
            aria-pressed={muted}
            title={t(muted ? 'mic.unmute' : 'mic.mute')}
            className="lv-mic"
            onClick={toggleMute}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              toggleMute()
            }}
          >
            <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M6 4a2 2 0 0 1 4 0v4a2 2 0 0 1-4 0V4M4 7v1a4 4 0 0 0 8 0V7M8 12v2M6 14h4"
                stroke="currentColor"
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
              />
              {muted ? <line x1={2} y1={2} x2={14} y2={14} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" /> : null}
            </svg>
          </span>
        ) : null}
        <span
          role="button"
          tabIndex={sessionId ? 0 : -1}
          aria-label={title}
          aria-pressed={enabled}
          aria-busy={connecting}
          data-state={status}
          aria-disabled={sessionId ? undefined : true}
          title={title}
          className={className}
          onClick={() => { if (!sessionId) return; if (active) void stop(); else void start() }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            if (!sessionId) return
            if (active) void stop(); else void start()
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, minWidth: 34, maxWidth: 34, flex: '0 0 auto',
            padding: 0, margin: 0, background: 'transparent', border: 'none',
            boxShadow: 'none', outline: 'none', cursor: sessionId ? 'pointer' : 'default',
            opacity: sessionId ? 1 : 0.45, userSelect: 'none', lineHeight: 0,
          }}
        >
          <svg width={34} height={34} viewBox="0 0 34 34" aria-hidden="true" style={{ display: 'block' }}>
            <circle
              cx={17}
              cy={17}
              r={16.5}
              fill={enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-primary-foreground)'}
              stroke={connecting ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l3)'}
              strokeWidth={1}
              strokeDasharray={connecting ? '8 5' : undefined}
            />
            {ORB_BARS.map(([x, height], index) => (
              <rect
                key={index}
                className="lv-bar"
                x={x}
                y={17 - height / 2}
                width={1.25}
                height={height}
                rx={0.625}
                fill={enabled ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)'}
                style={{ animationDelay: `${index * 90}ms` }}
              />
            ))}
          </svg>
        </span>
      </div>
    )
  }

  const DictationTail = createDictationTail(dictation)

  ctx.effect(() => ctx.locale.register(NS, LABELS))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'live-voice-dictation',
    order: 30,
    locale: NS,
  }, DictationTail))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'live-voice',
    order: 20,
    locale: NS,
  }, LiveVoice))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@rumi/live-voice',
    locale: NS,
  }, LiveVoiceSettings))
}
