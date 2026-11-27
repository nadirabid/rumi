/** Live Voice bundle settings built on shared DSH settings primitives. */
import * as React from 'react'
import { SettingsForm, SettingsSecretField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.ts'

interface KeyState {
  hasKey: boolean
  hint: string
  file: string
}

/**
 * The settings card accepts a replacement secret and reads only its status.
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

  const save = React.useCallback(async () => {
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
      setNote(t('settings.saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [value, t])

  const summary = state === null
    ? t('settings.reading')
    : state === false
      ? t('settings.unavailable')
      : state.hasKey
        ? t('settings.summaryCurrent', { hint: state.hint })
        : t('settings.summaryMissing')

  if (view === 'summary') return <span>{summary}</span>

  const hint = state === null
    ? t('settings.reading')
    : state === false
      ? t('settings.unavailable')
      : state.hasKey
        ? t('settings.current', { hint: state.hint, file: state.file })
        : t('settings.missing')

  const available = state !== false
  const ready = state !== null && state !== false

  return (
    <div className="lv-settings">
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
          unavailable: t('settings.unavailable'),
          readOnly: t('settings.reading'),
          saveFailed: error || t('settings.unavailable'),
          save: t('settings.save'),
          saving: t('settings.saving'),
        }}
        onSave={save}
        onDiscard={() => { setValue(''); setError(''); setNote('') }}
      >
        <SettingsSecretField
          id="lv-openai-api-key"
          label={t('settings.fieldLabel')}
          hint={hint}
          configured={Boolean(state && state.hasKey)}
          stateLabel={summary}
          text={value}
          onEdit={(next) => { setValue(next); setError(''); setNote('') }}
          disabled={busy || !ready}
        />
      </SettingsForm>
      {note ? <p role="status" className="lv-settings-note">{note}</p> : null}
    </div>
  )
}
