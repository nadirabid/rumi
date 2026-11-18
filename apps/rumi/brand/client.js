/**
 * Rumi brand — browser half.
 *
 * Occupies the sidebar brand seats so the app shows its own wordmark instead
 * of the DeepSeek Harness mark. It also contributes the Live Voice key page:
 * the voice plugin ships inside Rumi as a built-in bundle, so it has no
 * removable Plugins card of its own, but its key still needs a form.
 * Plain components, no build step: the shell provides React and the slot
 * registry at runtime.
 */
window.__ModuleLoader__.load({
  id: '@rumi/brand',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * The wordmark, not a glyph: the app icon is the word "rumi" set in Arial,
     * and the sidebar and hero repeat it in the same face so the mark inside
     * the app matches the one in the Dock.
     */
    const FONT = 'Arial, Helvetica, "Helvetica Neue", sans-serif';

    /** Plain wordmark; `size` is the caller's icon box, scaled to set type. */
    function Wordmark({ size = 26, className }) {
      return h('span', {
        className,
        role: 'img',
        'aria-label': 'Rumi',
        style: {
          fontFamily: FONT,
          fontSize: Math.round(size * 0.65),
          fontWeight: 400,
          letterSpacing: '-0.012em',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          color: 'inherit',
        },
      }, 'rumi');
    }

    /** The wordmark already names the product; the name seat stays empty. */
    function NoName() {
      return null;
    }

    /** Keep the stock speed statistics visible while hiding the other developer chrome. */
    const HIDDEN_CHROME = 'rumi-hidden-chrome';

    /** Rules removing developer chrome while preserving the layout it defined. */
    const HIDDEN_CHROME_RULES = [
      '[data-composer-dock] { visibility: hidden !important; }',
      '[data-composer-stat="activity"] { visibility: visible !important; }',
      '[data-conversation-tabs] { display: none !important; }',
      'header div:has(> [data-conversation-tabs]) { display: none !important; }',
      'header:has([data-conversation-tabs]) { min-height: 0 !important; padding-bottom: 10px !important; }',
      // The add-files menu opens a listbox of commands and file pickers. Rumi
      // takes files by drag and by asking, so the control only offers a
      // developer's menu. `aria-haspopup` survives class hashing and locale.
      'button[aria-haspopup="listbox"] { display: none !important; }',
      // The stock send button sits two pixels higher than the row centres it, as
      // an optical nudge applied with its own transform. The live-voice orb is
      // ours, so it follows with an offset that composes with the orb's own
      // hover scale instead of replacing it.
      '.lv-orb, .lv-mic { position: relative; top: -2px; }',
      // An empty activity slot still has a wrapper; hide it to avoid a second toolbar gap.
      'div:has(> [data-slot="conversation.input.activity"]:only-child:empty) { display: none; }',
    ].join('\n');

    /** Filter composer and header chrome; the disposer removes the rules again. */
    function hideChrome() {
      if (document.getElementById(HIDDEN_CHROME) !== null) return () => {};
      const style = document.createElement('style');
      style.id = HIDDEN_CHROME;
      style.textContent = HIDDEN_CHROME_RULES;
      document.head.append(style);
      return () => { style.remove(); };
    }

    /** Size chat automatically until a divider drag chooses a proportional split; double-click resets it. */
    function styleViewerLayout() {
      const style = document.createElement('style');
      style.id = 'rumi-viewer-layout';
      const frame = '[data-sidebar-collapsed]:not([data-rightbar-collapsed]):not([data-rightbar-fullscreen]):has([data-sidebar-right-panel="push"][data-sidebar-right-open] .rumi-print-viewer)';
      const handleSelector = `${frame}>[data-side="rightbar"]`;
      style.textContent = `
${frame}{--rumi-chat-width:clamp(240px,var(--rumi-chat-share,min(25%,500px)),calc(100% - 300px));grid-template-columns:0px var(--rumi-chat-width) minmax(0,1fr)!important}
${frame} [data-sidebar-right-panel="push"]{width:100%!important;--dsh-sidebar-width:100%!important}
${handleSelector}{left:var(--rumi-chat-width)!important}
`;
      document.head.append(style);
      const changed = new Set();
      let drag = null;
      function handle(event) {
        return event.target instanceof Element ? event.target.closest(handleSelector) : null;
      }
      function update(event) {
        const bounds = drag.frame.getBoundingClientRect();
        const width = Math.max(240, Math.min(bounds.width - 300, event.clientX - bounds.left - drag.offset));
        drag.frame.style.setProperty('--rumi-chat-share', `${width / bounds.width * 100}%`);
        changed.add(drag.frame);
      }
      function finish() {
        if (!drag) return;
        const previous = drag;
        drag = null;
        if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
      }
      function down(event) {
        const target = handle(event);
        if (!target || event.button !== 0 || drag) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const owner = target.parentElement;
        const bounds = target.getBoundingClientRect();
        drag = { handle: target, frame: owner, id: event.pointerId, offset: event.clientX - bounds.left - bounds.width / 2 };
        target.setPointerCapture(event.pointerId);
      }
      function move(event) {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault(); event.stopImmediatePropagation();
        update(event);
      }
      function up(event) {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault(); event.stopImmediatePropagation();
        update(event); finish();
      }
      function cancel(event) { if (drag?.id === event.pointerId) finish(); }
      function reset(event) {
        const target = handle(event);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        finish();
        target.parentElement.style.removeProperty('--rumi-chat-share');
        changed.delete(target.parentElement);
      }
      const listeners = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, lostpointercapture: cancel, dblclick: reset };
      for (const [name, listener] of Object.entries(listeners)) document.addEventListener(name, listener, true);
      window.addEventListener('blur', finish);
      return () => {
        finish();
        for (const [name, listener] of Object.entries(listeners)) document.removeEventListener(name, listener, true);
        window.removeEventListener('blur', finish);
        for (const owner of changed) owner.style.removeProperty('--rumi-chat-share');
        style.remove();
      };
    }

    /** Rumi document tabs reserve separate space for their title and close control. */
    function styleDocumentTabs() {
      const style = document.createElement('style');
      style.id = 'rumi-document-tabs';
      style.textContent = `
[data-sidebar-right-session] [data-dockkit-strip]{box-sizing:border-box;height:auto;min-height:50px;padding:4px 8px 4px var(--dsh-dockkit-strip-inline-start,8px)}
[data-sidebar-right-session] [data-dockkit-strip-tabs]{gap:8px;padding:4px}
[data-sidebar-right-session] [data-dockkit-strip-tabs]>div:not([data-dockkit-tab]):not([data-dockkit-caret]){display:none}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]{box-sizing:border-box;flex:0 0 auto;width:max-content;min-width:0;max-width:280px;height:34px;gap:8px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary-foreground) 55%,transparent),0 1px 3px var(--dsw-alias-bg-mask-2)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab][aria-selected="true"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-title]{mask-image:none}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-title][data-dockkit-tab-clipped]{mask-image:linear-gradient(to right,var(--dsw-alias-label-primary) calc(100% - 16px),transparent)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-close]{position:static;flex:none;width:20px;height:20px;opacity:1;pointer-events:auto;border-radius:50%;corner-shape:round}
[data-sidebar-right-session] [data-dockkit-strip]>button{width:34px;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;corner-shape:round;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:0 1px 3px var(--dsw-alias-bg-mask-2)}
[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab]:focus-visible,[data-sidebar-right-session] [data-dockkit-strip] button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
@media(pointer:coarse){[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab],[data-sidebar-right-session] [data-dockkit-strip]>button{min-height:44px}[data-sidebar-right-session] [data-dockkit-strip] [data-dockkit-tab-close]{width:28px;height:28px}}
`;
      document.head.append(style);
      return () => { style.remove(); };
    }

    /**
     * The Session header's open-in-finder split button and its overflow menu
     * (Session download and feedback) are developer affordances. Shadowing
     * their own list ids renders nothing there without disturbing the other
     * header utilities.
     */
    function NoHeaderUtility() {
      return null;
    }

    const NS = 'rumi.brand';

    const en = {
      title: 'Live Voice',
      intro: 'Talk to Rumi with GPT-Live. Sessions use an OpenAI key, kept in a file only you can read.',
      reading: 'Reading the stored key…',
      current: 'Key {hint} is stored in {file}.',
      missing: 'No OpenAI key is stored yet.',
      summaryCurrent: 'Key {hint}',
      summaryMissing: 'No key stored',
      fieldLabel: 'OpenAI API key',
      placeholder: 'sk-...',
      save: 'Save key',
      saving: 'Saving…',
      saved: 'Saved. The next live session uses it.',
      empty: 'Enter a key first.',
      unavailable: 'Live Voice is not running in this profile.',
      failed: 'Could not save the key: {message}',
    };

    const zh = {
      title: '实时语音',
      intro: '用 GPT-Live 与 Rumi 对话。会话需要一个 OpenAI 密钥，保存在只有你能读取的文件中。',
      reading: '正在读取已保存的密钥…',
      current: '密钥 {hint} 保存在 {file}。',
      missing: '尚未保存 OpenAI 密钥。',
      summaryCurrent: '密钥 {hint}',
      summaryMissing: '未保存密钥',
      fieldLabel: 'OpenAI API 密钥',
      placeholder: 'sk-...',
      save: '保存密钥',
      saving: '保存中…',
      saved: '已保存。下一次实时会话将使用它。',
      empty: '请先输入密钥。',
      unavailable: '此配置文件中未运行实时语音。',
      failed: '保存密钥失败：{message}',
    };

    /**
     * The key form for the built-in Live Voice bundle. The host owns the file;
     * this page only reads its status and writes a new key through the plugin's
     * own route, so the desktop app and Rumi share one stored key.
     */
    function LiveVoiceSettings({ view, t }) {
      const [state, setState] = React.useState(null);
      const [value, setValue] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/api/live-voice/settings', { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error(`status ${response.status}`);
          const result = await response.json();
          setState({ hasKey: Boolean(result.hasKey), hint: result.hint ?? '', file: result.file ?? '' });
        } catch {
          setState(false);
        }
      }, []);
      React.useEffect(() => { void load(); }, [load]);

      const save = async () => {
        const key = value.trim();
        if (key === '') { setError(t('empty')); return; }
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
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
          setState({ hasKey: true, hint: result.hint ?? '', file: result.file ?? '' });
          setValue('');
          setNote(t('saved'));
        } catch (cause) {
          setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }));
        } finally {
          setBusy(false);
        }
      };

      if (view === 'summary') {
        if (state === null) return h('span', null, t('reading'));
        if (state === false) return h('span', null, t('unavailable'));
        return h('span', null, state.hasKey ? t('summaryCurrent', { hint: state.hint }) : t('summaryMissing'));
      }

      return h('div', { style: { display: 'grid', gap: 10, padding: '2px 0 14px' } },
        h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.75 } }, t('intro')),
        h('p', { style: { margin: 0, fontSize: 12, opacity: 0.8 } },
          state === null ? t('reading')
            : state === false ? t('unavailable')
              : state.hasKey ? t('current', { hint: state.hint, file: state.file })
                : t('missing')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            type: 'password',
            value,
            placeholder: t('placeholder'),
            'aria-label': t('fieldLabel'),
            autoComplete: 'off',
            spellCheck: false,
            disabled: busy,
            onChange: event => setValue(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') void save(); },
            style: {
              flex: '1 1 280px', height: 32, padding: '0 10px', borderRadius: 8,
              border: '1px solid rgba(128, 140, 160, 0.4)', background: 'transparent',
              color: 'inherit', fontFamily: 'monospace', fontSize: 12,
            },
          }),
          h('button', {
            type: 'button',
            disabled: busy || value.trim() === '',
            onClick: () => { void save(); },
            style: {
              height: 32, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid rgba(122, 208, 255, 0.45)', background: 'rgba(122, 208, 255, 0.12)',
              color: 'inherit', fontSize: 12, opacity: busy || value.trim() === '' ? 0.6 : 1,
            },
          }, busy ? t('saving') : t('save')),
        ),
        error ? h('p', { role: 'alert', style: { margin: 0, fontSize: 11, color: '#ff8a8a' } }, error) : null,
        note ? h('p', { style: { margin: 0, fontSize: 11, opacity: 0.6 } }, note) : null,
      );
    }

    /** Edit new-conversation defaults without changing an existing Session. */
    function registerDefaultModel(ctx) {
      const { SettingsForm, SettingsFormModel, SettingsSecretField, Button, Menu } = require('@deepseek-ai/dsh-client-ui-primitives');
      const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
      const ns = 'rumi.default-model';
      const dictionaries = {
        en: { advanced: 'Advanced provider settings', connections: 'Provider connections', removeKey: 'Disconnect', confirmRemove: 'Confirm disconnect',  direct: 'DeepSeek API', baseten: 'DeepSeek via Baseten', manage: 'Manage', connect: 'Connect', close: 'Close', connected: 'Configured', missing: 'Not configured', checking: 'Checking…', key: 'API key', saveKey: 'Save key', keyHint: 'Enter a new key to update this connection.', voice: 'Live voice', voiceInfo: 'Uses a separately billed OpenAI API key.', plan: 'ChatGPT plan', planInfo: 'Sign in for project conversations, then choose your default model below. Live voice uses your separately billed OpenAI API key.', signIn: 'Sign in with ChatGPT', continueLogin: 'Continue in browser', disconnect: 'Disconnect ChatGPT', cancelLogin: 'Cancel sign-in', planError: 'Could not connect to ChatGPT. Retry sign-in.', title: 'Project conversations', intro: 'Used for new conversations. Existing conversations keep their model and effort.', model: 'Model', effort: 'Reasoning effort', automatic: 'Model default', choose: 'Choose a model', unavailableModel: 'Saved model unavailable', empty: 'No models available. Connect a provider below.', loadFailed: 'Could not load all models. Retry to refresh the list.', retry: 'Retry', unavailable: 'Default model settings are unavailable.', readOnly: 'These settings are read-only.', saveFailed: 'Could not save the default. Check your connection and try again.', save: 'Save default', saving: 'Saving…', saved: 'Default saved.', invalidEffort: 'Choose an effort supported by this model.' },
        zh: { advanced: '高级服务商设置', connections: '服务商连接', removeKey: '断开连接', confirmRemove: '确认断开连接',  direct: 'DeepSeek API', baseten: '通过 Baseten 使用 DeepSeek', manage: '管理', connect: '连接', close: '关闭', connected: '已配置', missing: '未配置', checking: '正在检查…', key: 'API 密钥', saveKey: '保存密钥', keyHint: '输入新密钥以更新此连接。', voice: '实时语音', voiceInfo: '使用单独计费的 OpenAI API 密钥。', plan: 'ChatGPT 套餐', planInfo: '登录后可在下方选择项目对话的默认模型。实时语音使用单独计费的 OpenAI API 密钥。', signIn: '使用 ChatGPT 登录', continueLogin: '在浏览器中继续', disconnect: '断开 ChatGPT', cancelLogin: '取消登录', planError: '无法连接 ChatGPT，请重试。', title: '项目对话', intro: '用于新对话。现有对话保留各自的模型和推理强度', model: '模型', effort: '推理强度', automatic: '模型默认值', choose: '选择模型', unavailableModel: '已保存的模型不可用', empty: '没有可用模型。请先在下方配置服务商', loadFailed: '无法加载全部模型。请重试刷新列表', retry: '重试', unavailable: '默认模型设置不可用', readOnly: '这些设置为只读', saveFailed: '无法保存默认值。请检查连接后重试', save: '保存默认值', saving: '正在保存…', saved: '默认值已保存', invalidEffort: '请选择此模型支持的推理强度' },
      };
      ctx.effect(() => ctx.locale.register(ns, dictionaries), 'rumi-brand: default model copy');
      const scope = ctx.configForms.get('agent-default-model');
      const model = new SettingsFormModel(scope, ['provider', 'model', 'reasoningEffort'].map(field => ({
        field,
        format: value => typeof value === 'string' ? value : '',
        parse: text => text ? { kind: 'set', value: text } : field === 'reasoningEffort' ? { kind: 'clear' } : undefined,
      })));
      const actions = model.actions();
      const form = model.bind(() => ({ shell: model.shell(), provider: model.field('provider').text, model: model.field('model').text, effort: model.field('reasoningEffort').text }));
      const catalog = createSnapshotStore({ value: null, failed: false, loading: true });
      let generation = 0;
      let disposed = false;
      async function refresh() {
        const request = ++generation;
        catalog.set({ ...catalog.getSnapshot(), loading: true });
        try {
          const result = await ctx.remote.session.modelCatalog();
          if (disposed || request !== generation) return;
          if (!result.ok) throw new Error(result.error.code);
          catalog.set({ value: result.value, failed: result.value.failures.length > 0, loading: false });
        } catch (error) {
          // The retained catalog stays visible; the page owns retry feedback.
          if (!disposed && request === generation) catalog.set({ ...catalog.getSnapshot(), failed: true, loading: false });
        }
      }
      ctx.effect(() => {
        const off = ['settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated', 'llm/adapters-updated'].map(event => ctx.remote.$on(event, refresh));
        void refresh();
        return () => { disposed = true; generation++; off.forEach(dispose => dispose()); model.dispose(); };
      }, 'rumi-brand: default model state');
      ctx.on('connection/reset', () => { catalog.set({ value: null, failed: false, loading: true }); void refresh(); });
      const keyOf = (provider, id) => JSON.stringify([provider, id]);
      const voiceCopy = ctx.locale.bind(NS);
      function checked(response) {
        if (!response.ok) throw new Error(response.error.code);
        return response.value;
      }
      async function keyRoute(kind) {
        const settings = checked(await ctx.remote.settings.describe());
        const space = settings.namespaces.find(entry => entry.ns === (kind === 'direct' ? 'llm-deepseek' : 'llm-pi-ai'));
        if (!space) throw new Error('Provider settings unavailable');
        const profile = kind === 'direct' ? space.value : space.value.providers?.baseten;
        const ref = profile?.apiKeyEnv ?? (kind === 'baseten' ? 'BASETEN_API_KEY' : undefined);
        if (!ref) throw new Error('Missing credential reference');
        return { space, profile, ref };
      }
      const basetenFlashFast = {
        id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast',
        name: 'DeepSeek V4.1 Flash 1017 Fast',
        contextWindow: 1048576,
        input: ['text', 'image'],
        reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
        compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true,
          requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'openai', maxTokensField: 'max_tokens' },
      };
      function KeyConnection({ kind, isDefault, t }) {
        const [info, setInfo] = React.useState(null);
        const [editing, setEditing] = React.useState(false);
        const [confirm, setConfirm] = React.useState(false);
        const [text, setText] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [failed, setFailed] = React.useState(false);
        const [revision, reload] = React.useReducer(n => n + 1, 0);
        React.useEffect(() => {
          let active = true;
          async function load() {
            const { ref, profile } = await keyRoute(kind);
            const value = checked(await ctx.remote.credentials.describe([ref]))[ref];
            if (active) { setInfo({ ...value, configured: Boolean(profile && value.configured) }); setFailed(false); }
          }
          void load().catch(() => { if (active) setFailed(true); });
          const off = ctx.remote.$on('credentials/reference-updated', reload);
          return () => { active = false; off(); };
        }, [kind, revision]);
        async function disconnect() {
          if (!confirm) { setConfirm(true); return; }
          setBusy(true);
          try {
            const { ref } = await keyRoute(kind);
            checked(await ctx.remote.credentials.unset(ref));
            setEditing(false); setConfirm(false); setText(''); reload(); void refresh();
          } catch (error) { setFailed(true); } finally { setBusy(false); }
        }
        async function save() {
          setBusy(true); setFailed(false);
          try {
            const { ref, space, profile } = await keyRoute(kind);
            if (kind === 'baseten' && !profile?.apiKeyEnv) {
              const op = profile ? { path: ['providers', 'baseten', 'apiKeyEnv'], value: ref }
                : { path: ['providers', 'baseten'], value: { displayName: 'DeepSeek via Baseten', apiKeyEnv: ref,
                    models: [basetenFlashFast, { id: 'deepseek-ai/DeepSeek-V4-Pro' }] } };
              checked(await ctx.remote.settings.mutate(space.ns, [{ op: 'set', ...op }], space.revision));
            }
            checked(await ctx.remote.credentials.set(ref, text.trim()));
            setText(''); setEditing(false); reload(); void refresh();
          } catch (error) { setFailed(true); } finally { setBusy(false); }
        }
        return h('div', { className: 'rumi-connection' },
          h('div', { className: 'rumi-default-model-row' },
            h('div', null, h('strong', null, t(kind)), h('p', null, t(info ? info.configured ? 'connected' : 'missing' : 'checking'))),
            h(Button, { variant: 'outline', disabled: busy || !info, onClick: () => { setText(''); setConfirm(false); setEditing(!editing); } }, t(editing ? 'close' : info?.configured ? 'manage' : 'connect'))),
          editing && h(SettingsForm, { state: { available: true, writable: info.writable, dirty: Boolean(text.trim()), invalid: !info.writable, saving: busy, failed },
            labels: { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('saveKey'), saving: t('saving') },
            onSave: save, onDiscard: () => {} },
            h(SettingsSecretField, { id: 'rumi-key-' + kind, label: t('key'), hint: t('keyHint'), configured: info.configured,
              stateLabel: t(info.configured ? 'connected' : 'missing'), text, onEdit: setText, disabled: busy || !info.writable })),
          editing && !isDefault && info.configured && info.writable && info.source === 'file' && h(Button, { disabled: busy, onClick: disconnect }, t(confirm ? 'confirmRemove' : 'removeKey')),
          failed && !editing && h(Button, { onClick: reload }, t('retry')));
      }
      function ChatGPTSettings({ t, isDefault }) {
        const [state, setState] = React.useState({});
        const [managing, setManaging] = React.useState(false);
        const [confirm, setConfirm] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const generation = React.useRef(0);
        async function update(action) {
          const version = ++generation.current;
          if (action) setBusy(true);
          try {
            const response = await fetch('/api/rumi-chatgpt', action ? {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rumi-Settings': '1' },
              body: JSON.stringify({ action }),
            } : { cache: 'no-store' });
            if (!response.ok) throw new Error(String(response.status));
            const next = await response.json();
            if (version === generation.current) setState(next);
          } catch (error) {
            if (version === generation.current) setState(previous => ({ ...previous, failed: true }));
          } finally {
            if (version === generation.current) setBusy(false);
          }
        }
        React.useEffect(() => { void update(); return () => { generation.current++; }; }, []);
        React.useEffect(() => {
          if (!state.pending || busy) return;
          const id = setTimeout(() => { void update(); }, 800);
          return () => clearTimeout(id);
        }, [state, busy]);
        return h('div', { className: 'rumi-connection' }, h('div', { className: 'rumi-default-model-row' }, h('div', null, h('strong', null, t('plan')), h('p', null, t(state.connected === undefined ? 'checking' : state.connected ? 'connected' : 'missing'))), h(Button, { variant: 'outline', onClick: () => { setManaging(!managing); setConfirm(false); } }, t(managing ? 'close' : state.connected ? 'manage' : 'connect'))),
          state.failed ? h('p', { role: 'alert' }, t('planError')) : null,
          state.url ? h('a', { href: state.url, target: '_blank', rel: 'noopener noreferrer' }, t('continueLogin')) : null,
          (managing || state.pending) && h(Button, { disabled: busy || (isDefault && state.connected && !state.pending), onClick: () => {
              if (state.connected && !state.pending && !confirm) { setConfirm(true); return; }
              setConfirm(false); void update(state.pending ? 'cancel' : state.connected ? 'disconnect' : 'start');
            } },
            t(state.pending ? 'cancelLogin' : state.connected ? (confirm ? 'confirmRemove' : 'disconnect') : 'signIn')));
      }
      function DefaultModelSettings({ useForm, useCatalog, t, operations }) {
        const state = useForm(value => value);
        const persistedProvider = scope.getSnapshot().value?.provider;
        const directory = useCatalog(value => value);
        const [open, setOpen] = React.useState(null);
        const [advanced, setAdvanced] = React.useState(false);
        const [saved, setSaved] = React.useState(false);
        const groups = directory.value?.groups ?? [];
        const provider = groups.find(group => group.id === state.provider);
        const selected = provider?.models.find(item => item.id === state.model);
        const efforts = selected?.reasoning?.efforts ?? [];
        const invalidEffort = Boolean(state.effort) && !efforts.some(item => item.id === state.effort);
        const blocked = !state.shell.writable || state.shell.saving || directory.loading;
        const groupName = group => group.id === 'baseten' ? t('baseten') : group.id === 'deepseek' ? t('direct') : group.name;
        const items = groups.flatMap(group => [
          { type: 'label', id: keyOf(group.id, ''), text: groupName(group) },
          ...group.models.map(item => ({ id: keyOf(group.id, item.id), label: item.name })),
        ]);
        const choose = id => {
          const [providerId, modelId] = JSON.parse(id);
          const next = groups.find(group => group.id === providerId)?.models.find(item => item.id === modelId);
          if (!next) return;
          operations.edit('provider', providerId);
          operations.edit('model', modelId);
          operations.edit('reasoningEffort', next.reasoning?.defaultEffort ?? '');
          setSaved(false); setOpen(null);
        };
        return h('section', { 'aria-label': t('title'), className: 'rumi-default-model', 'data-advanced': advanced },
          h('h3', null, t('title')), h('p', null, t('intro')),
          directory.failed ? h('p', { role: 'status' }, t('loadFailed'), ' ', h(Button, { onClick: operations.refresh, disabled: directory.loading }, t('retry'))) : null,
          h(SettingsForm, {
            state: { ...state.shell, invalid: state.shell.invalid || !selected || invalidEffort || blocked },
            labels: Object.fromEntries(['unavailable', 'readOnly', 'saveFailed', 'save', 'saving'].map(key => [key, t(key)])),
            onDiscard: operations.discard,
            onSave: async () => { setSaved(false); if (await operations.save()) setSaved(true); },
          },
          h('div', { className: 'rumi-default-model-row' }, h('span', { id: 'rumi-default-model-label' }, t('model')),
            h(Menu, { open: open === 'model', portal: true, items, selectedId: keyOf(state.provider, state.model), onSelect: choose, onClose: () => setOpen(null),
              anchor: h(Button, { variant: 'outline', disabled: blocked || items.length === 0, 'aria-labelledby': 'rumi-default-model-label rumi-default-model-value', 'aria-haspopup': 'menu', 'aria-expanded': open === 'model', onClick: () => setOpen(open === 'model' ? null : 'model') },
                h('span', { id: 'rumi-default-model-value' }, selected ? `${groupName(provider)} · ${selected.name}` : state.model ? t('unavailableModel') : t('choose'))) })),
          items.length === 0 && !directory.loading ? h('p', { role: 'status' }, t('empty')) : null,
          selected && (efforts.length > 0 || state.effort) ? h('div', { className: 'rumi-default-model-row' }, h('span', { id: 'rumi-default-effort-label' }, t('effort')),
            h(Menu, { open: open === 'effort', portal: true, selectedId: state.effort, items: [{ id: '', label: t('automatic') }, ...efforts.map(item => ({ id: item.id, label: item.name }))],
              onSelect: id => { operations.edit('reasoningEffort', id); setSaved(false); setOpen(null); }, onClose: () => setOpen(null),
              anchor: h(Button, { variant: 'outline', disabled: blocked, 'aria-labelledby': 'rumi-default-effort-label rumi-default-effort-value', 'aria-haspopup': 'menu', 'aria-expanded': open === 'effort', onClick: () => setOpen(open === 'effort' ? null : 'effort') }, h('span', { id: 'rumi-default-effort-value' }, efforts.find(item => item.id === state.effort)?.name ?? (state.effort || t('automatic')))) })) : null,
          invalidEffort && selected ? h('p', { role: 'status' }, t('invalidEffort')) : null,
          saved && !state.shell.dirty ? h('p', { role: 'status' }, t('saved')) : null),
          h('h3', null, t('connections')), h(ChatGPTSettings, { t, isDefault: persistedProvider === 'rumi-chatgpt' }),
          h(KeyConnection, { kind: 'direct', isDefault: persistedProvider === 'deepseek', t }), h(KeyConnection, { kind: 'baseten', isDefault: persistedProvider === 'baseten', t }),
          h('h3', null, t('voice')), h('details', { className: 'rumi-connection' }, h('summary', null, h(LiveVoiceSettings, { view: 'summary', t: voiceCopy })), h('p', null, t('voiceInfo')), h(LiveVoiceSettings, { view: 'page', t: voiceCopy })),
          h(Button, { variant: 'outline', 'aria-expanded': advanced, onClick: () => setAdvanced(!advanced) }, t('advanced')));
      }
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = '.rumi-connection{padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);margin-bottom:8px}.rumi-connection p{margin:3px 0}.rumi-connection strong{font-weight:500}.rumi-default-model h3{margin:20px 0 10px}.rumi-default-model h3:first-child{margin-top:0}.rumi-default-model h3{font-size:inherit;font-weight:500}.rumi-default-model p{color:var(--dsw-alias-label-secondary);font-size:13px}.rumi-default-model-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}.rumi-default-model-row button{max-width:100%;height:auto;min-height:36px;white-space:normal;overflow-wrap:anywhere}';
        const footer = '[data-slot="settings.models.footer"]';
        style.textContent += `div:has(> ${footer} .rumi-default-model[data-advanced="false"]) > :not(${footer}){display:none}.rumi-default-model{order:-1}`;
        document.head.append(style);
        return () => style.remove();
      }, 'rumi-brand: default model styles');
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'rumi-default-model', locale: ns,
        inject: () => ({ hooks: { form, catalog }, operations: { ...actions, refresh, save: async () => { await model.save(); return !model.shell().failed; } } }),
      }, DefaultModelSettings));
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.inject(['configForms', 'remote', 'remote.session', 'remote.credentials', 'remote.settings'], registerDefaultModel);
        ctx.effect(styleViewerLayout, 'rumi-brand: responsive viewer layout');
        ctx.effect(hideChrome, 'rumi-brand: hide developer chrome');
        ctx.effect(styleDocumentTabs, 'rumi-brand: document tab glass');
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rumi-brand: live voice copy');
        ctx.slots.inject('conversation.session.header.utilities', function* () {
          yield ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'open-in-app',
            order: -10,
            priority: -1,
          }, NoHeaderUtility);
          yield ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'session-log-download',
            priority: -1,
          }, NoHeaderUtility);
        });
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
          name: 'sidebar.brand.mark',
          id: 'rumi-brand',
        }, Wordmark));
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
          name: 'sidebar.brand.name',
          id: 'rumi-brand',
        }, NoName));
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
          name: 'conversation.hero.brand.mark',
          id: 'rumi-brand',
        }, Wordmark));
        ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'rumi-live-voice',
          order: 50,
          label: () => t('title'),
          locale: NS,
        }, LiveVoiceSettings));
      },
    };
  },
});
