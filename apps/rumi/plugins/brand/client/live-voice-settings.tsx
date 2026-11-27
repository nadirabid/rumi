import * as React from 'react'
import { SettingsForm, SettingsSecretField } from '@deepseek-ai/dsh-client-ui-primitives'

export const LIVE_VOICE_NS = 'rumi.brand'

export const liveVoiceLocales = {
  en: {
    title: 'Live Voice',
    intro: 'Talk to Rumi with GPT-Live. Sessions use an OpenAI key, kept in a file only you can read.',
    reading: 'Reading the stored key…',
    current: 'Key {hint} is stored in {file}.',
    missing: 'No OpenAI key is stored yet.',
    summaryCurrent: 'Key {hint}',
    summaryMissing: 'No key stored',
    fieldLabel: 'OpenAI API key',
    save: 'Save key',
    saving: 'Saving…',
    saved: 'Saved. The next live session uses it.',
    unavailable: 'Live Voice is not running in this profile.',
    failed: 'Could not save the key: {message}',
  },
  zh: {
    title: '实时语音',
    intro: '用 GPT-Live 与 Rumi 对话。会话需要一个 OpenAI 密钥，保存在只有你能读取的文件中。',
    reading: '正在读取已保存的密钥…',
    current: '密钥 {hint} 保存在 {file}。',
    missing: '尚未保存 OpenAI 密钥。',
    summaryCurrent: '密钥 {hint}',
    summaryMissing: '未保存密钥',
    fieldLabel: 'OpenAI API 密钥',
    save: '保存密钥',
    saving: '保存中…',
    saved: '已保存。下一次实时会话将使用它。',
    unavailable: '此配置文件中未运行实时语音。',
    failed: '保存密钥失败：{message}',
  },
}

interface KeyState {
  hasKey: boolean
  hint: string
  file: string
}

type Translate = (key: string, params?: Record<string, string>) => string

/**
 * Live Voice key settings built on DSH shared settings primitives.
 * The host owns the stored key; this page reads status and writes updates via `/api/live-voice/settings`.
 */
export function LiveVoiceSettings({ view, t }: { view: 'summary' | 'page'; t: Translate }) {
  const [state, setState] = React.useState<KeyState | null | false>(null)
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [note, setNote] = React.useState('')

  React.useEffect(() => {
    let active = true
    async function load() {
      try {
        const response = await fetch('/api/live-voice/settings', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const result = await response.json()
        if (active) setState({ hasKey: Boolean(result.hasKey), hint: result.hint ?? '', file: result.file ?? '' })
      } catch {
        if (active) setState(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const save = async () => {
    const key = value.trim()
    if (key === '') return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const response = await fetch('/api/live-voice/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
        credentials: 'same-origin',
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`)
      setState({ hasKey: true, hint: result.hint ?? '', file: result.file ?? '' })
      setValue('')
      setNote(t('saved'))
    } catch (cause) {
      setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }

  const stateLabel = state === null
    ? t('reading')
    : state === false
      ? t('unavailable')
      : state.hasKey
        ? t('summaryCurrent', { hint: state.hint })
        : t('summaryMissing')

  if (view === 'summary') return <span>{stateLabel}</span>

  const hint = state === null
    ? t('reading')
    : state === false
      ? t('unavailable')
      : state.hasKey
        ? t('current', { hint: state.hint, file: state.file })
        : t('missing')

  const available = state !== false
  const ready = state !== null && state !== false

  return (
    <div className="rumi-voice-settings">
      <p className="rumi-voice-note">{t('intro')}</p>
      <SettingsForm
        state={{
          available,
          writable: ready,
          dirty: value.trim() !== '',
          invalid: !ready,
          saving: busy,
          failed: error !== '',
        }}
        labels={{
          unavailable: t('unavailable'),
          readOnly: t('reading'),
          saveFailed: error || t('unavailable'),
          save: t('save'),
          saving: t('saving'),
        }}
        onSave={save}
        onDiscard={() => { setValue(''); setError(''); setNote('') }}
      >
        <SettingsSecretField
          id="rumi-live-voice-key"
          label={t('fieldLabel')}
          hint={hint}
          configured={Boolean(state && state.hasKey)}
          stateLabel={stateLabel}
          text={value}
          onEdit={(next) => { setValue(next); setError(''); setNote('') }}
          disabled={busy || !ready}
        />
      </SettingsForm>
      {note ? <p role="status" className="rumi-voice-note">{note}</p> : null}
    </div>
  )
}
