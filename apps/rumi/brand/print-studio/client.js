import { installViewer } from './viewer/client.js'
/**
 * Print Studio — browser half.
 *
 * The setup card under Plugins → Built-in plugin settings. The host discovers
 * the printer on the LAN; an adult signs in once with their Bambu account so
 * the host can fetch the printer's access code. Bambu Connect sends sliced jobs.
 * The page uses the shared settings-form primitives so it matches every other
 * plugin settings page.
 */
window.__ModuleLoader__.load({
  id: '@rumi/print-studio',
  factory(require) {
    const React = require('react');
    const {
      Button, Tag,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const NS = 'rumi.printStudio';

    const en = {
      hostedSignIn: 'Sign in with Bambu',
      printTest: 'Print 5-minute test tile',
      printTestHint: 'Slices a small tile, opens Bambu Connect, and waits for you to press Send.',
      slicing: 'Slicing…',
      awaitingSend: 'Bambu Connect is open. Select the H2D and Supertack Plate, then press Send.',
      printProgress: 'Print progress',
      printFinished: 'Print finished.',
      printFailed: 'Print failed.',
      printRemaining: 'min remaining',
      desktopRequired: 'Open Rumi on your Mac to sign in with Bambu.',
      title: 'Print Studio',
      checking: 'Looking for the printer…',
      ready: 'Ready to make something',
      needsSetup: 'Setup needed',
      intro: 'Print Studio finds your printer. Sign in with your Bambu account to read its status. Sliced jobs open in Bambu Connect for you to send.',
      slicer: 'Slicer',
      notInstalled: 'not installed',
      download: 'Download Bambu Studio',
      profilesMissing: 'Open Bambu Studio once with the H2D selected',
      printer: 'Printer',
      searching: 'Searching this network…',
      noPrinter: 'No printer found. Turn it on and make sure it is on the same Wi-Fi.',
      scan: 'Scan again',
      choose: 'Choose the printer',
      cloudMode: 'Cloud mode',
      cloudDetail: 'The printer is connected to Bambu Cloud. Sign in to fetch its access code for status monitoring. Bambu Connect sends print jobs.',
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
      hostedSignIn: '登录 Bambu 账号',
      printTest: '打印 5 分钟测试片',
      printTestHint: '切一个小测试片，打开 Bambu Connect，等待你点击发送。',
      slicing: '切片中…',
      awaitingSend: 'Bambu Connect 已打开。请选择 H2D 和 Supertack 打印板，然后点击发送。',
      printProgress: '打印进度',
      printFinished: '打印完成。',
      printFailed: '打印失败。',
      printRemaining: '分钟剩余',
      desktopRequired: '请在 Mac 上打开 Rumi 并登录 Bambu 账号',
      title: '打印工作室',
      checking: '正在寻找打印机…',
      ready: '可以开始创作了',
      needsSetup: '需要设置',
      intro: '打印工作室会自动寻找打印机。请登录 Bambu 账号以读取打印机状态。切片后会打开 Bambu Connect，由你发送打印任务。',
      slicer: '切片软件',
      notInstalled: '未安装',
      download: '下载 Bambu Studio',
      profilesMissing: '请打开一次 Bambu Studio 并选择 H2D',
      printer: '打印机',
      searching: '正在搜索网络…',
      noPrinter: '没有找到打印机。请打开打印机并确认它与电脑在同一 Wi-Fi。',
      scan: '重新扫描',
      choose: '选择打印机',
      cloudMode: '云模式',
      cloudDetail: '打印机已连接 Bambu 云端。登录后可获取访问码以监控状态。打印任务通过 Bambu Connect 发送。',
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

    /**
     * The setup card. The summary view is the card one-liner; the page view is
     * the discovered printer, the setup steps, and the Bambu account form.
     */
    function PrintStudio({ view, t }) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [ssoWaiting, setSsoWaiting] = React.useState(false);
      const [printJob, setPrintJob] = React.useState(null);
      const [printStatus, setPrintStatus] = React.useState(null);
      const [printBusy, setPrintBusy] = React.useState(false);
      const [printError, setPrintError] = React.useState('');

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

      const startTestPrint = async () => {
        setPrintBusy(true);
        setPrintError('');
        setPrintStatus(null);
        try {
          const response = await fetch('/api/print-studio/print/test', { method: 'POST', credentials: 'same-origin' });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.error) throw new Error(result.error ?? `status ${response.status}`);
          setPrintJob(result);
        } catch (cause) {
          setPrintError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setPrintBusy(false);
        }
      };

      React.useEffect(() => {
        if (printJob === null) return;
        let active = true;
        const poll = async () => {
          try {
            const response = await fetch('/api/print-studio/print/status', { credentials: 'same-origin', cache: 'no-store' });
            const result = await response.json().catch(() => ({}));
            if (!active) return;
            if (!response.ok || result.error) {
              setPrintError(result.error ?? `status ${response.status}`);
              return;
            }
            setPrintStatus(result);
            if (result.state === 'FINISH' || result.state === 'FAILED') active = false;
          } catch {
            // Keep polling while the printer is warming up.
          }
        };
        void poll();
        const timer = setInterval(() => { void poll(); }, 2000);
        return () => { active = false; clearInterval(timer); };
      }, [printJob]);

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
        h(StatusLine, { label: t('slicer') },
          slicer.found
            ? `${slicer.name}${slicer.version === null ? '' : ` ${slicer.version}`}`
            : h(React.Fragment, null,
              t('notInstalled'),
              ' · ',
              h('a', { href: status.downloadUrl, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-link)' } }, t('download')))),
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


      const printSection = status?.ready
        ? h('div', { style: { display: 'grid', gap: 8 } },
          h(Button, { variant: 'outline', disabled: printBusy, onClick: () => { void startTestPrint(); } },
            printBusy ? t('slicing') : t('printTest')),
          h('p', { style: subtle }, t('printTestHint')),
          printJob === null ? null : h('div', { style: { display: 'grid', gap: 4 } },
            printStatus === null
              ? h('p', { style: subtle }, t('awaitingSend'))
              : printStatus.state === 'FINISH'
                ? h(StatusLine, { label: t('printProgress') }, t('printFinished'))
                : printStatus.state === 'FAILED' || (printStatus.printError !== null && printStatus.printError !== 0)
                  ? h('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
                    `${t('printFailed')} ${printStatus.failReason ?? printStatus.printError ?? ''}`)
                  : h(StatusLine, { label: t('printProgress') },
                    `${printStatus.percent ?? 0}% · ${printStatus.layer ?? 0}/${printStatus.totalLayers ?? 0} · ${printStatus.remainingMinutes ?? 0} ${t('printRemaining')}`),
            printError === '' ? null : h('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, printError)))
        : null;

      const feedback = h(React.Fragment, null,
        error !== ''
          ? h('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error)
          : null,
        note === '' ? null : h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, note));

      return h('div', { style: { display: 'grid', gap: 12 } },
        h('p', { style: subtle }, t('intro')),
        status === null
          ? h('p', { style: subtle }, t('checking'))
          : h('div', { style: { display: 'grid', gap: 12 } }, statusPanel, account, printSection, feedback),
      );
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'documentPreviews'],
      apply(ctx) {
        installViewer(ctx, React, require('@deepseek-ai/dsh-client-ui-primitives'));
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
