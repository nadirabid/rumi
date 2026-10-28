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

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rumi-brand: live voice copy');
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
