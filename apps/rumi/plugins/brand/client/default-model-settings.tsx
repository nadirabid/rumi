import * as React from 'react'
import { Button, Menu, SettingsForm, SettingsFormModel, SettingsSecretField } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LIVE_VOICE_NS, LiveVoiceSettings } from './live-voice-settings.tsx'

const DEFAULT_MODEL_NS = 'rumi.default-model'

const DICTIONARIES = {
  en: {
    advanced: 'Advanced provider settings', connections: 'Provider connections', removeKey: 'Disconnect', confirmRemove: 'Confirm disconnect',
    direct: 'DeepSeek API', baseten: 'DeepSeek via Baseten', manage: 'Manage', connect: 'Connect', close: 'Close',
    connected: 'Configured', missing: 'Not configured', checking: 'Checking…', key: 'API key', saveKey: 'Save key',
    keyHint: 'Enter a new key to update this connection.', voice: 'Live voice', voiceInfo: 'Uses a separately billed OpenAI API key.',
    plan: 'ChatGPT plan', planInfo: 'Sign in for project conversations, then choose your default model below. Live voice uses your separately billed OpenAI API key.',
    signIn: 'Sign in with ChatGPT', signInAgain: 'Sign in again', signInRequired: 'Sign-in required', continueLogin: 'Continue in browser',
    disconnect: 'Disconnect ChatGPT', cancelLogin: 'Cancel sign-in', planError: 'Could not connect to ChatGPT. Retry sign-in.',
    title: 'Project conversations', intro: 'Used for new conversations. Existing conversations keep their model and effort.',
    model: 'Model', effort: 'Reasoning effort', automatic: 'Model default', choose: 'Choose a model',
    unavailableModel: 'Saved model unavailable', empty: 'No models available. Connect a provider below.',
    loadFailed: 'Could not load all models. Retry to refresh the list.', retry: 'Retry',
    unavailable: 'Default model settings are unavailable.', readOnly: 'These settings are read-only.',
    saveFailed: 'Could not save the default. Check your connection and try again.',
    save: 'Save default', saving: 'Saving…', saved: 'Default saved.', invalidEffort: 'Choose an effort supported by this model.',
  },
  zh: {
    advanced: '高级服务商设置', connections: '服务商连接', removeKey: '断开连接', confirmRemove: '确认断开连接',
    direct: 'DeepSeek API', baseten: '通过 Baseten 使用 DeepSeek', manage: '管理', connect: '连接', close: '关闭',
    connected: '已配置', missing: '未配置', checking: '正在检查…', key: 'API 密钥', saveKey: '保存密钥',
    keyHint: '输入新密钥以更新此连接。', voice: '实时语音', voiceInfo: '使用单独计费的 OpenAI API 密钥。',
    plan: 'ChatGPT 套餐', planInfo: '登录后可在下方选择项目对话的默认模型。实时语音使用单独计费的 OpenAI API 密钥。',
    signIn: '使用 ChatGPT 登录', signInAgain: '重新登录', signInRequired: '需要登录', continueLogin: '在浏览器中继续',
    disconnect: '断开 ChatGPT', cancelLogin: '取消登录', planError: '无法连接 ChatGPT，请重试。',
    title: '项目对话', intro: '用于新对话。现有对话保留各自的模型和推理强度',
    model: '模型', effort: '推理强度', automatic: '模型默认值', choose: '选择模型',
    unavailableModel: '已保存的模型不可用', empty: '没有可用模型。请先在下方配置服务商',
    loadFailed: '无法加载全部模型。请重试刷新列表', retry: '重试',
    unavailable: '默认模型设置不可用', readOnly: '这些设置为只读',
    saveFailed: '无法保存默认值。请检查连接后重试',
    save: '保存默认值', saving: '正在保存…', saved: '默认值已保存', invalidEffort: '请选择此模型支持的推理强度',
  },
}

const BASETEN_FLASH_FAST = {
  id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast',
  name: 'DeepSeek V4.1 Flash 1017 Fast',
  contextWindow: 1048576,
  input: ['text', 'image'],
  reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
  compat: {
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'openai',
    maxTokensField: 'max_tokens',
  },
}

const keyOf = (provider: string, id: string) => JSON.stringify([provider, id])

function checked<T>(response: { ok: boolean; value?: T; error?: { code: string } }): T {
  if (!response.ok) throw new Error(response.error?.code ?? 'request_failed')
  return response.value as T
}

/** Register Rumi's provider-connections and default-model surface on Settings -> Models. */
export function registerDefaultModel(ctx: any) {
  ctx.effect(() => ctx.locale.register(DEFAULT_MODEL_NS, DICTIONARIES), 'rumi-brand: default model copy')
  const scope = ctx.configForms.get('agent-default-model')
  const model = new SettingsFormModel(scope, ['provider', 'model', 'reasoningEffort'].map(field => ({
    field,
    format: (value: unknown) => typeof value === 'string' ? value : '',
    parse: (text: string) => text ? { kind: 'set' as const, value: text } : field === 'reasoningEffort' ? { kind: 'clear' as const } : undefined,
  })))
  const actions = model.actions()
  const form = model.bind(() => ({
    shell: model.shell(),
    provider: model.field('provider').text,
    model: model.field('model').text,
    effort: model.field('reasoningEffort').text,
  }))
  const catalog = createSnapshotStore<{ value: any; failed: boolean; loading: boolean }>({ value: null, failed: false, loading: true })
  let generation = 0
  let disposed = false

  async function refresh() {
    const request = ++generation
    catalog.set({ ...catalog.getSnapshot(), loading: true })
    try {
      const result = await ctx.remote.session.modelCatalog()
      if (disposed || request !== generation) return
      if (!result.ok) throw new Error(result.error.code)
      catalog.set({ value: result.value, failed: result.value.failures.length > 0, loading: false })
    } catch {
      if (!disposed && request === generation) catalog.set({ ...catalog.getSnapshot(), failed: true, loading: false })
    }
  }

  ctx.effect(() => {
    const off = ['settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated', 'llm/adapters-updated']
      .map(event => ctx.remote.$on(event, refresh))
    void refresh()
    return () => { disposed = true; generation++; off.forEach(dispose => dispose()); model.dispose() }
  }, 'rumi-brand: default model state')
  ctx.on('connection/reset', () => { catalog.set({ value: null, failed: false, loading: true }); void refresh() })

  const voiceCopy = ctx.locale.bind(LIVE_VOICE_NS)

  async function keyRoute(kind: 'direct' | 'baseten') {
    const settings = checked<any>(await ctx.remote.settings.describe())
    const space = settings.namespaces.find((entry: any) => entry.ns === (kind === 'direct' ? 'llm-deepseek' : 'llm-pi-ai'))
    if (!space) throw new Error('Provider settings unavailable')
    const profile = kind === 'direct' ? space.value : space.value.providers?.baseten
    const ref = profile?.apiKeyEnv ?? (kind === 'baseten' ? 'BASETEN_API_KEY' : undefined)
    if (!ref) throw new Error('Missing credential reference')
    return { space, profile, ref }
  }

  function KeyConnection({ kind, isDefault, t }: { kind: 'direct' | 'baseten'; isDefault: boolean; t: (key: string) => string }) {
    const [info, setInfo] = React.useState<any>(null)
    const [editing, setEditing] = React.useState(false)
    const [confirm, setConfirm] = React.useState(false)
    const [text, setText] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const [revision, reload] = React.useReducer((n: number) => n + 1, 0)

    React.useEffect(() => {
      let active = true
      async function load() {
        const { ref, profile } = await keyRoute(kind)
        const value = checked<any>(await ctx.remote.credentials.describe([ref]))[ref]
        if (active) { setInfo({ ...value, configured: Boolean(profile && value.configured) }); setFailed(false) }
      }
      void load().catch(() => { if (active) setFailed(true) })
      const off = ctx.remote.$on('credentials/reference-updated', reload)
      return () => { active = false; off() }
    }, [kind, revision])

    async function disconnect() {
      if (!confirm) { setConfirm(true); return }
      setBusy(true)
      try {
        const { ref } = await keyRoute(kind)
        checked(await ctx.remote.credentials.unset(ref))
        setEditing(false); setConfirm(false); setText(''); reload(); void refresh()
      } catch { setFailed(true) } finally { setBusy(false) }
    }

    async function save() {
      setBusy(true); setFailed(false)
      try {
        const { ref, space, profile } = await keyRoute(kind)
        if (kind === 'baseten' && !profile?.apiKeyEnv) {
          const op = profile
            ? { path: ['providers', 'baseten', 'apiKeyEnv'], value: ref }
            : { path: ['providers', 'baseten'], value: { displayName: 'DeepSeek via Baseten', apiKeyEnv: ref, models: [BASETEN_FLASH_FAST, { id: 'deepseek-ai/DeepSeek-V4-Pro' }] } }
          checked(await ctx.remote.settings.mutate(space.ns, [{ op: 'set', ...op }], space.revision))
        }
        checked(await ctx.remote.credentials.set(ref, text.trim()))
        setText(''); setEditing(false); reload(); void refresh()
      } catch { setFailed(true) } finally { setBusy(false) }
    }

    return (
      <div className="rumi-connection">
        <div className="rumi-default-model-row">
          <div>
            <strong>{t(kind)}</strong>
            <p>{t(info ? (info.configured ? 'connected' : 'missing') : 'checking')}</p>
          </div>
          <Button variant="outline" disabled={busy || !info} onClick={() => { setText(''); setConfirm(false); setEditing(!editing) }}>
            {t(editing ? 'close' : info?.configured ? 'manage' : 'connect')}
          </Button>
        </div>
        {editing && (
          <SettingsForm
            state={{ available: true, writable: info.writable, dirty: Boolean(text.trim()), invalid: !info.writable, saving: busy, failed }}
            labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('saveKey'), saving: t('saving') }}
            onSave={save}
            onDiscard={() => {}}
          >
            <SettingsSecretField
              id={`rumi-key-${kind}`}
              label={t('key')}
              hint={t('keyHint')}
              configured={info.configured}
              stateLabel={t(info.configured ? 'connected' : 'missing')}
              text={text}
              onEdit={setText}
              disabled={busy || !info.writable}
            />
          </SettingsForm>
        )}
        {editing && !isDefault && info.configured && info.writable && info.source === 'file' && (
          <Button disabled={busy} onClick={disconnect}>{t(confirm ? 'confirmRemove' : 'removeKey')}</Button>
        )}
        {failed && !editing && <Button onClick={reload}>{t('retry')}</Button>}
      </div>
    )
  }

  function ChatGPTSettings({ t, isDefault }: { t: (key: string) => string; isDefault: boolean }) {
    const [state, setState] = React.useState<any>({})
    const [managing, setManaging] = React.useState(false)
    const [confirm, setConfirm] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const versionRef = React.useRef(0)

    async function update(action?: string) {
      const version = ++versionRef.current
      if (action) setBusy(true)
      try {
        const response = await fetch('/api/rumi-chatgpt', action
          ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rumi-Settings': '1' }, body: JSON.stringify({ action }) }
          : { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const next = await response.json()
        if (version === versionRef.current) setState(next)
      } catch {
        if (version === versionRef.current) setState((previous: any) => ({ ...previous, failed: true }))
      } finally {
        if (version === versionRef.current) setBusy(false)
      }
    }

    React.useEffect(() => {
      void update()
      const off = ctx.remote.$on('credentials/record-updated', (key: string) => { if (key === 'rumi-chatgpt/account') void update() })
      return () => { versionRef.current++; off() }
    }, [])

    React.useEffect(() => {
      if (!state.pending || busy) return
      const id = setTimeout(() => { void update() }, 800)
      return () => clearTimeout(id)
    }, [state, busy])

    const { connected, reauthRequired, pending } = state
    const status = reauthRequired ? 'signInRequired' : connected === undefined ? 'checking' : connected ? 'connected' : 'missing'

    return (
      <div className="rumi-connection">
        <div className="rumi-default-model-row">
          <div>
            <strong>{t('plan')}</strong>
            <p>{t(status)}</p>
          </div>
          {reauthRequired
            ? <Button variant="outline" disabled={busy || pending} onClick={() => { void update('start') }}>{t('signInAgain')}</Button>
            : <Button variant="outline" onClick={() => { setManaging(!managing); setConfirm(false) }}>{t(managing ? 'close' : connected ? 'manage' : 'connect')}</Button>}
        </div>
        {state.failed ? <p role="alert">{t('planError')}</p> : null}
        {state.url ? <a href={state.url} target="_blank" rel="noopener noreferrer">{t('continueLogin')}</a> : null}
        {pending && <Button disabled={busy} onClick={() => { void update('cancel') }}>{t('cancelLogin')}</Button>}
        {managing && !pending && !reauthRequired && (
          <Button disabled={busy} onClick={() => { setConfirm(false); void update('start') }}>{t(connected ? 'signInAgain' : 'signIn')}</Button>
        )}
        {managing && connected && !pending && (
          <Button disabled={busy || isDefault} onClick={() => {
            if (!confirm) { setConfirm(true); return }
            setConfirm(false); void update('disconnect')
          }}>{t(confirm ? 'confirmRemove' : 'disconnect')}</Button>
        )}
      </div>
    )
  }

  function DefaultModelSettings({ useForm, useCatalog, t, operations }: any) {
    const state = useForm((value: any) => value)
    const persistedProvider = scope.getSnapshot().value?.provider
    const directory = useCatalog((value: any) => value)
    const [open, setOpen] = React.useState<'model' | 'effort' | null>(null)
    const [advanced, setAdvanced] = React.useState(false)
    const [saved, setSaved] = React.useState(false)

    const groups: any[] = directory.value?.groups ?? []
    const provider = groups.find(group => group.id === state.provider)
    const selected = provider?.models.find((item: any) => item.id === state.model)
    const efforts: any[] = selected?.reasoning?.efforts ?? []
    const invalidEffort = Boolean(state.effort) && !efforts.some(item => item.id === state.effort)
    const blocked = !state.shell.writable || state.shell.saving || directory.loading
    const groupName = (group: any) => group.id === 'baseten' ? t('baseten') : group.id === 'deepseek' ? t('direct') : group.name
    const items = groups.flatMap(group => [
      { type: 'label', id: keyOf(group.id, ''), text: groupName(group) },
      ...group.models.map((item: any) => ({ id: keyOf(group.id, item.id), label: item.name })),
    ])

    const choose = (id: string) => {
      const [providerId, modelId] = JSON.parse(id)
      const next = groups.find(group => group.id === providerId)?.models.find((item: any) => item.id === modelId)
      if (!next) return
      operations.edit('provider', providerId)
      operations.edit('model', modelId)
      operations.edit('reasoningEffort', next.reasoning?.defaultEffort ?? '')
      setSaved(false)
      setOpen(null)
    }

    return (
      <section aria-label={t('title')} className="rumi-default-model" data-advanced={advanced}>
        <h3>{t('title')}</h3>
        <p>{t('intro')}</p>
        {directory.failed ? (
          <p role="status">
            {t('loadFailed')}{' '}
            <Button onClick={operations.refresh} disabled={directory.loading}>{t('retry')}</Button>
          </p>
        ) : null}
        <SettingsForm
          state={{ ...state.shell, invalid: state.shell.invalid || !selected || invalidEffort || blocked }}
          labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }}
          onDiscard={operations.discard}
          onSave={async () => { setSaved(false); if (await operations.save()) setSaved(true) }}
        >
          <div className="rumi-default-model-row">
            <span id="rumi-default-model-label">{t('model')}</span>
            <Menu
              open={open === 'model'}
              portal={true}
              items={items}
              selectedId={keyOf(state.provider, state.model)}
              onSelect={choose}
              onClose={() => setOpen(null)}
              anchor={
                <Button
                  variant="outline"
                  disabled={blocked || items.length === 0}
                  aria-labelledby="rumi-default-model-label rumi-default-model-value"
                  aria-haspopup="menu"
                  aria-expanded={open === 'model'}
                  onClick={() => setOpen(open === 'model' ? null : 'model')}
                >
                  <span id="rumi-default-model-value">
                    {selected ? `${groupName(provider)} · ${selected.name}` : state.model ? t('unavailableModel') : t('choose')}
                  </span>
                </Button>
              }
            />
          </div>
          {items.length === 0 && !directory.loading ? <p role="status">{t('empty')}</p> : null}
          {selected && (efforts.length > 0 || state.effort) ? (
            <div className="rumi-default-model-row">
              <span id="rumi-default-effort-label">{t('effort')}</span>
              <Menu
                open={open === 'effort'}
                portal={true}
                selectedId={state.effort}
                items={[{ id: '', label: t('automatic') }, ...efforts.map(item => ({ id: item.id, label: item.name }))]}
                onSelect={(id: string) => { operations.edit('reasoningEffort', id); setSaved(false); setOpen(null) }}
                onClose={() => setOpen(null)}
                anchor={
                  <Button
                    variant="outline"
                    disabled={blocked}
                    aria-labelledby="rumi-default-effort-label rumi-default-effort-value"
                    aria-haspopup="menu"
                    aria-expanded={open === 'effort'}
                    onClick={() => setOpen(open === 'effort' ? null : 'effort')}
                  >
                    <span id="rumi-default-effort-value">
                      {efforts.find(item => item.id === state.effort)?.name ?? (state.effort || t('automatic'))}
                    </span>
                  </Button>
                }
              />
            </div>
          ) : null}
          {invalidEffort && selected ? <p role="status">{t('invalidEffort')}</p> : null}
          {saved && !state.shell.dirty ? <p role="status">{t('saved')}</p> : null}
        </SettingsForm>
        <h3>{t('connections')}</h3>
        <ChatGPTSettings t={t} isDefault={persistedProvider === 'rumi-chatgpt'} />
        <KeyConnection kind="direct" isDefault={persistedProvider === 'deepseek'} t={t} />
        <KeyConnection kind="baseten" isDefault={persistedProvider === 'baseten'} t={t} />
        <h3>{t('voice')}</h3>
        <details className="rumi-connection">
          <summary><LiveVoiceSettings view="summary" t={voiceCopy} /></summary>
          <p>{t('voiceInfo')}</p>
          <LiveVoiceSettings view="page" t={voiceCopy} />
        </details>
        <Button variant="outline" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t('advanced')}</Button>
      </section>
    )
  }

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'rumi-default-model',
    locale: DEFAULT_MODEL_NS,
    inject: () => ({
      hooks: { form, catalog },
      operations: { ...actions, refresh, save: async () => { await model.save(); return !model.shell().failed } },
    }),
  }, DefaultModelSettings))
}
