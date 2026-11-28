import { installViewer } from './viewer/client.js'
import { installBadges } from './badges/client.js'
/**
 * Print Studio — browser half.
 *
 * The setup card under Plugins → Built-in plugin settings. The host discovers
 * the printer on the LAN; an adult signs in once with their Bambu account so
 * the host can fetch the printer's access code for monitoring.
 * The page uses the shared settings-form primitives so it matches every other
 * plugin settings page.
 */
window.__ModuleLoader__.load({
  id: '@rumi/print-studio',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const {
      Button, Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const NS = 'rumi.printStudio';

    const en = {
      studio: 'Bambu Studio',
      setupButton: 'Set up {app}',
      setupReady: 'Installed',
      setupDownloading: 'Downloading {app}…',
      setupVerifying: 'Verifying {app}…',
      setupInstalling: 'Installing {app}…',
      setupFailed: '{app} setup failed. Check your connection and try again.',
      setupUnsupported: '{app} setup requires a Mac with Apple Silicon or Intel.',
      setupDestination: 'An incomplete {app} copy is blocking setup. Move it out of Rumi’s print-studio/applications folder, then retry.',
      setupCleanup: 'Setup could not remove its temporary files. Restart Rumi and try again.',
      studioHint: 'Open a plate from the 3D preview to slice and print it in Bambu Studio.',
      hostedSignIn: 'Sign in with Bambu',
      desktopRequired: 'Open Rumi on your Mac to sign in with Bambu.',
      title: 'Print Studio',
      checking: 'Looking for the printer…',
      ready: 'Ready to make something',
      needsSetup: 'Setup needed',
      intro: 'Print Studio finds your printer. Sign in with your Bambu account to read its status.',
      notInstalled: 'not installed',
      profilesMissing: 'The installed Bambu Studio has no H2D profiles. Update Bambu Studio.',
      printer: 'Printer',
      searching: 'Searching this network…',
      noPrinter: 'No printer found. Turn it on and make sure it is on the same Wi-Fi.',
      scan: 'Scan again',
      choose: 'Choose the printer',
      cloudMode: 'Cloud mode',
      cloudDetail: 'The printer is connected to Bambu Cloud. Sign in to fetch its access code for status monitoring.',
      next: 'Next steps',
      ssoWaitingDetail: 'Complete sign-in in the Bambu window.',
      signedIn: 'Signed in to Bambu',
      codeFetched: 'The printer’s access code was fetched and stored.',
      noBoundPrinter: 'Signed in, but no bound printer with an access code was found. Check that the printer is bound to this account.',
      retry: 'Refresh from Bambu',
      signOut: 'Sign out',
      signInFailed: 'Bambu sign-in failed.',
      signInClosed: 'Bambu sign-in was closed.',
      loadFailed: 'Could not read the Print Studio status.',
    };

    const zh = {
      studio: 'Bambu Studio',
      setupButton: '设置 {app}',
      setupReady: '已安装',
      setupDownloading: '正在下载 {app}…',
      setupVerifying: '正在验证 {app}…',
      setupInstalling: '正在安装 {app}…',
      setupFailed: '{app} 设置失败，请检查网络连接后重试',
      setupUnsupported: '{app} 设置需要 Apple 芯片或 Intel Mac',
      setupDestination: '不完整的 {app} 阻止了设置，请将其移出 Rumi 的 print-studio/applications 文件夹后重试',
      setupCleanup: '无法删除设置临时文件，请重启 Rumi 后重试',
      studioHint: '从 3D 预览中打开打印板，在 Bambu Studio 中切片并打印。',
      hostedSignIn: '登录 Bambu 账号',
      desktopRequired: '请在 Mac 上打开 Rumi 并登录 Bambu 账号',
      title: '打印工作室',
      checking: '正在寻找打印机…',
      ready: '可以开始创作了',
      needsSetup: '需要设置',
      intro: '打印工作室会自动寻找打印机。请登录 Bambu 账号以读取打印机状态。',
      notInstalled: '未安装',
      profilesMissing: '已安装的 Bambu Studio 没有 H2D 配置文件，请更新 Bambu Studio',
      printer: '打印机',
      searching: '正在搜索网络…',
      noPrinter: '没有找到打印机。请打开打印机并确认它与电脑在同一 Wi-Fi。',
      scan: '重新扫描',
      choose: '选择打印机',
      cloudMode: '云模式',
      cloudDetail: '打印机已连接 Bambu 云端。登录后可获取访问码以监控状态。',
      next: '下一步',
      ssoWaitingDetail: '请在 Bambu 窗口中完成登录',
      signedIn: '已登录 Bambu',
      codeFetched: '已获取并保存打印机的访问码。',
      noBoundPrinter: '已登录，但没有找到带访问码的已绑定打印机。请确认打印机已绑定到此账号。',
      retry: '从 Bambu 刷新',
      signOut: '退出登录',
      signInFailed: 'Bambu 登录失败。',
      signInClosed: 'Bambu 登录已关闭。',
      loadFailed: '无法读取打印工作室状态。',
    };

    const subtle = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' };
    const labelStyle = { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };

    /** One labelled status line. */
    function StatusLine({ label, children }) {
      return h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
        h('span', { style: { ...labelStyle, minWidth: 64 } }, label),
        h('span', { style: subtle }, children));
    }

    /** Poll Bambu Studio setup while the settings page is active. */
    function useStudioSetup(active) {
      const [setup, setSetup] = React.useState(null);
      const [requestFailed, setRequestFailed] = React.useState(false);
      React.useEffect(() => {
        if (!active) return;
        let live = true;
        let timer;
        const poll = async () => {
          try {
            const response = await fetch('/api/print-studio/studio/status', { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) throw new Error('Setup status unavailable');
            const result = await response.json();
            if (live) { setSetup(result); setRequestFailed(false); }
          } catch (error) {
            if (live) setRequestFailed(true);
          } finally {
            if (live) timer = setTimeout(poll, 2000);
          }
        };
        void poll();
        return () => { live = false; clearTimeout(timer); };
      }, [active]);
      const start = async () => {
        setRequestFailed(false);
        setSetup({ installed: false, phase: 'downloading', error: null });
        try {
          const response = await fetch('/api/print-studio/studio/install', { method: 'POST', credentials: 'same-origin' });
          if (!response.ok) throw new Error('Setup unavailable');
          setSetup(await response.json());
        } catch (error) { setRequestFailed(true); setSetup(null); }
      };
      return { setup, requestFailed, start };
    }

    /** Bambu Studio installation status and action. */
    function StudioSetup({ installedText, installer, t }) {
      const { setup, requestFailed, start } = installer;
      const name = t('studio');
      const busy = ['downloading', 'verifying', 'installing'].includes(setup?.phase);
      return h('div', { style: { display: 'grid', gap: 8 } },
        h(StatusLine, { label: name }, setup?.installed ? installedText : t('notInstalled')),
        setup?.installed ? null : h(Button, { variant: 'outline', disabled: busy,
          onClick: () => { void start(); } }, t('setupButton', { app: name })),
        h('p', { style: subtle, role: 'status' }, busy
          ? t({ downloading: 'setupDownloading', verifying: 'setupVerifying', installing: 'setupInstalling' }[setup.phase], { app: name })
          : t('studioHint')),
        requestFailed || setup?.phase === 'failed'
          ? h('p', { role: 'alert', style: subtle }, t(setup?.error === 'unsupported' ? 'setupUnsupported'
            : setup?.error === 'cleanupFailed' ? 'setupCleanup' : setup?.error === 'destinationExists' ? 'setupDestination' : 'setupFailed', { app: name })) : null);
    }

    /**
     * The setup card. The summary view is the card one-liner; the page view is
     * the discovered printer, the setup steps, and the Bambu account form.
     */
    function PrintStudio({ view, t }) {
      const [status, setStatus] = React.useState(null);
      const studio = useStudioSetup(view !== 'summary');

      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [ssoWaiting, setSsoWaiting] = React.useState(false);

      const load = React.useCallback(async (refresh = false) => {
        try {
          const response = await fetch(`/api/print-studio/status${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw new Error(`status ${response.status}`);
          setStatus(await response.json());
        } catch {
          setError(t('loadFailed'));
        }
      }, []);
      React.useEffect(() => { void load(); }, [load]);
      // A just-installed Bambu Studio appears in the host's slicer detection only on a fresh read.
      React.useEffect(() => {
        if (studio.setup?.phase === 'ready' && status?.slicer?.found === false) void load();
      }, [studio.setup?.phase, status?.slicer?.found, load]);

      const startSso = async () => {
        setError('');
        setNote('');
        if (!window.__RUMI_BAMBU_LOGIN__) {
          setError(t('desktopRequired'));
          return;
        }
        setSsoWaiting(true);
        try {
          const message = await window.__RUMI_BAMBU_LOGIN__.open();
          const response = await fetch('/api/print-studio/cloud/complete', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message }), credentials: 'same-origin',
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? t('signInFailed'));
          setStatus(result);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : '';
          setError(message === 'Bambu sign-in closed' ? t('signInClosed') : message || t('signInFailed'));
        } finally {
          setSsoWaiting(false);
        }
      };

      const signOut = async () => {
        setError('');
        setNote('');
        try {
          const response = await fetch('/api/print-studio/cloud/signout', { method: 'POST', credentials: 'same-origin' });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
          setStatus(result);
          setError('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      };

      const retry = async () => {
        setError('');
        setNote('');
        try {
          const response = await fetch('/api/print-studio/cloud/refresh', { method: 'POST', credentials: 'same-origin' });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
          setStatus(result);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      };

      if (view === 'summary') {
        if (status === null) return h('span', null, t('checking'));
        return h('span', null, status.ready ? t('ready') : t('needsSetup'));
      }

      const printer = status?.printer;
      const discovered = status?.discovered ?? [];
      const signedIn = status?.cloud?.signedIn === true;
      const slicer = status === null ? null : status.slicer;

      const statusPanel = status === null ? null : h('div', { style: { display: 'grid', gap: 6 } },
        printer.mode === 'cloud' ? h(Tag, { tone: 'warning' }, t('cloudMode')) : null,
        printer.mode === 'cloud' ? h('p', { style: subtle }, t('cloudDetail')) : null,
        printer.model === 'H2D' && !slicer.profiles.h2d
          ? h(StatusLine, { label: t('profilesMissing') }, '')
          : null,
        h(StatusLine, { label: t('printer') },
          printer.host === null
            ? (discovered.length > 0 ? t('choose') : t('searching'))
            : `${printer.name ?? t('printer')} · ${printer.model} · ${printer.host}`),
        printer.host === null && discovered.length === 0 ? h('p', { style: subtle }, t('noPrinter')) : null,
        printer.host === null && discovered.length === 0
          ? h('div', null, h(Button, { variant: 'outline', size: 'sm', onClick: () => { void load(true); } }, t('scan')))
          : null,
        status.nextSteps.length === 0
          ? null
          : h('div', null,
            h('span', { style: labelStyle }, t('next')),
            h('ol', { style: { ...subtle, margin: '4px 0 0', paddingLeft: 18 } },
              status.nextSteps.map(step => h('li', { key: step.id }, h('strong', null, step.title), ' ', step.detail)))),
      );

      const account = signedIn
        ? h('div', { style: { display: 'grid', gap: 8 } },
          h(Tag, { tone: 'success' }, t('signedIn')),
          h('p', { style: subtle }, printer.hasAccessCode ? t('codeFetched') : t('noBoundPrinter')),
          h('div', { style: { display: 'flex', gap: 8 } },
            h(Button, { variant: 'outline', size: 'sm', onClick: () => { void retry(); } }, t('retry')),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => { void signOut(); } }, t('signOut'))))
        : status !== null && printer.hasAccessCode && status.ready
          ? null
          : h('div', { style: { display: 'grid', gap: 8 } },
            h(Button, { variant: 'outline', disabled: ssoWaiting,
              onClick: () => { void startSso(); } }, t('hostedSignIn')),
            ssoWaiting ? h('p', { style: subtle }, t('ssoWaitingDetail')) : null);

      const studioSection = h(StudioSetup, { t, installer: studio,
        installedText: slicer?.found ? `${slicer.name}${slicer.version === null ? '' : ` ${slicer.version}`}` : t('setupReady') });

      const feedback = h(React.Fragment, null,
        error !== ''
          ? h('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)
          : null,
        note === '' ? null : h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, note));

      return h('div', { style: { display: 'grid', gap: 12 } },
        h('p', { style: subtle }, t('intro')),
        status === null
          ? h('p', { style: subtle }, t('checking'))
          : h('div', { style: { display: 'grid', gap: 12 } }, statusPanel, studioSection, account, feedback),
      );
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'documentPreviews'],
      apply(ctx) {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        installViewer(ctx, React, primitives);
        installBadges(ctx, React, primitives, createPortal, require.asset);
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rumi print studio: copy');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: 'rumi-print-studio',
          order: 60,
          label: () => t('title'),
          locale: NS,
        }, PrintStudio));
      },
    };
  },
});
