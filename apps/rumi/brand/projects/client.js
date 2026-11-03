/**
 * Rumi projects — browser half.
 *
 * Home is the project gallery. A project is a directory; opening one starts or
 * reuses a DSH session whose working directory is that directory, then shows the
 * conversation. Closing returns to the gallery without ending the session, so a
 * running turn or an unsent draft survives.
 *
 * The gallery is a `main` panel, the New/Close control is the window-chrome
 * `shell.leading` seat, and the stock navigation column is collapsed once at
 * boot so the gallery owns the window.
 */
window.__ModuleLoader__.load({
  id: '@rumi/projects',
  factory(require) {
    const React = require('react');
    const { IconChevronLeftOutlineRegular, IconPlusOutlineRegular, IconPanelLeftOutlineRegular, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const PANEL_ID = 'projects';
    const NS = 'rumi.projects';
    const ROUTE = '/api/rumi-projects';

    const en = {
      title: 'Projects',
      count: '{count} projects',
      new: 'New',
      back: 'All projects',
      openPreview: 'Open sidebar',
      closePreview: 'Close sidebar',
      fullPreview: 'Full view',
      regularPreview: 'Regular view',
      empty: 'No projects yet.',
      emptyHint: 'Make one, then ask Rumi to help build it.',
      updated: 'Updated {when}',
      failed: 'That did not work. Try again.',
    };
    const zh = {
      title: '项目',
      count: '{count} 个项目',
      new: '新建',
      back: '所有项目',
      openPreview: '打开侧栏',
      closePreview: '关闭侧栏',
      fullPreview: '全屏视图',
      regularPreview: '常规视图',
      empty: '还没有项目',
      emptyHint: '先新建一个，然后请 Rumi 一起制作',
      updated: '更新于 {when}',
      failed: '没有成功，请再试一次',
    };

    const STYLES = `
[class*="heroWorkspaceRow"] > button[aria-haspopup="menu"]{display:none}
.rumi-projects{box-sizing:border-box;display:flex;flex-direction:column;gap:24px;width:100%;height:100%;min-height:0;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,48px) + 28px) clamp(20px,4vw,56px) 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.rumi-projects-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.rumi-projects-title{margin:0;font-size:22px;font-weight:500;letter-spacing:-0.02em}
.rumi-projects-count{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px 24px;align-items:start}
.rumi-project{display:flex;flex-direction:column;gap:8px;min-width:0;padding:0;border:0;background:none;text-align:left;cursor:pointer;color:inherit}
.rumi-project-cover img{display:block;width:100%;height:100%;object-fit:contain}
.rumi-project-cover{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:3/2;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);overflow:hidden;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-label-tertiary) 18%,transparent) .6px,transparent .7px) 0 0/12px 12px,var(--dsw-alias-bg-layer-1);transition:border-color 140ms ease,box-shadow 140ms ease}
.rumi-project-initial{width:40px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-base);box-shadow:0 2px 6px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.rumi-project:hover .rumi-project-cover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2));box-shadow:0 8px 20px rgba(0,0,0,.07);transform:none}
.rumi-project:active .rumi-project-cover{transform:none;box-shadow:none}
.rumi-project:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:18px}
.rumi-project-name{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.rumi-project-meta{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-empty{display:flex;flex-direction:column;gap:6px;max-width:320px;margin:auto;text-align:center}
.rumi-projects-empty-title{margin:0;font-size:14px;font-weight:600}
.rumi-projects-empty-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.rumi-projects-leading{position:fixed;inset:0 0 auto 0;box-sizing:border-box;height:var(--dsh-frame-top-clearance,48px);display:flex;align-items:center;gap:10px;padding:0 16px 0 88px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 92%,transparent);border-bottom:1px solid var(--dsw-alias-border-l2);backdrop-filter:blur(24px);-webkit-app-region:drag}
body:has(.rumi-projects-leading) header:has([data-conversation-tabs]){border-bottom-color:transparent}
/* The full-width project header reserves the same band above sidebar tabs. */
body:has(.rumi-projects-leading) [data-sidebar-right-panel]{top:var(--dsh-frame-top-clearance,48px)}
.rumi-projects-leading button{-webkit-app-region:no-drag;flex-shrink:0}
.rumi-header-title{font-size:14px;font-weight:500;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.rumi-header-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-shrink:0}
.rumi-sidebar-glyph{transform:scaleX(-1)}
.rumi-glass:disabled{opacity:.4;cursor:default}
body:has(.rumi-projects-leading) [data-dockkit-split-button],
body:has(.rumi-projects-leading) [data-dockkit-strip-chrome],
body:has(.rumi-projects-leading) [data-sidebar-right-expand]{display:none}
html[data-fullscreen] .rumi-projects-leading{padding-left:16px}
/* Liquid Glass: a translucent capsule over the window material. The specular
   inset and drop shade are material constants, not theme colors. */
.rumi-glass{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border-radius:50%;corner-shape:round;cursor:default;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 1px 2px rgba(0,0,0,.10);transition:background-color 120ms ease}
.rumi-glass:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent)}
.rumi-glass:active{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 85%,transparent)}
.rumi-glass:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media(max-width:900px){.rumi-projects-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.rumi-projects-grid{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.rumi-project-cover,.rumi-glass{transition:none}}
`;

    /** Copy and styles installed once per plugin instance. */
    function installChrome(ctx, t) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rumi projects: copy');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = STYLES;
        document.head.append(style);
        return () => style.remove();
      }, 'rumi projects: styles');
    }

    /** Published frame attributes reflect the sidebar's effective mode, including narrow windows. */
    function sidebarSource(sidebar) {
      return {
        getSnapshot: () => {
          if (sidebar.mounted.getSnapshot() === undefined) return 'none';
          if (!sidebar.isExpanded()) return 'closed';
          return document.querySelector('[data-rightbar-fullscreen]') ? 'full' : 'regular';
        },
        subscribe: listener => {
          const observer = new MutationObserver(listener);
          observer.observe(document.documentElement, {
            subtree: true, attributes: true,
            attributeFilter: ['data-rightbar-fullscreen', 'data-rightbar-collapsed', 'data-sidebar-right-open'],
          });
          const unmount = sidebar.mounted.subscribe(listener);
          return () => { observer.disconnect(); unmount(); };
        },
      };
    }

    /** The existing sidebar mode glyphs, kept at the top bar's 16px icon size. */
    function ModeGlyph({ full }) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        full
          ? [h('path', { key: 'a', d: 'M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5', stroke: 'currentColor' }),
             h('path', { key: 'b', d: 'M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5', stroke: 'currentColor' })]
          : h('path', { d: 'M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z', fill: 'currentColor' }));
    }

    /** One project list shared by the gallery and the window-chrome control. */
    function createProjectList(ctx) {
      let snapshot = { phase: 'loading', projects: [], error: '', activeId: null };
      const listeners = new Set();
      const publish = (next) => {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      };
      const json = (response) => response.json();
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        async load() {
          try {
            const response = await fetch(ROUTE, { cache: 'no-store' });
            if (!response.ok) throw new Error(`projects: ${response.status}`);
            publish({ phase: 'ready', projects: (await json(response)).projects ?? [], error: '' });
          } catch {
            publish({ phase: 'failed', error: 'load' });
          }
        },
        /** Create a project and open it; a new project has no session yet. */
        async create() {
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
            if (!response.ok) throw new Error(`projects: ${response.status}`);
            const { project } = await json(response);
            publish({ projects: [project, ...snapshot.projects], error: '' });
            await this.open(project);
            return project;
          } catch {
            publish({ error: 'create' });
            return null;
          }
        },
        async open(project) {
          try {
            const sessionId = await this.sessionFor(project);
            ctx.uiWorkspace.openSession(sessionId);
            ctx.layout.selectPanel(null);
            publish({ activeId: project.id, error: '' });
          } catch (error) {
            console.error('Rumi project opening failed', error);
            publish({ error: 'open' });
          }
        },
        close() {
          ctx.layout.selectPanel(PANEL_ID);
        },
        /**
         * The session that represents the project. DSH conversations belong to
         * a Workspace, so the project directory is registered as one (create is
         * idempotent by path) and the workspace resolves the session: its
         * recorded one while the Host still lists it, otherwise the blank the
         * workspace connects.
         */
        async sessionFor(project) {
          const known = ctx.sessions.list.getSnapshot();
          const byId = known?.byId;
          const exists = (id) => byId instanceof Map ? byId.has(id) : Boolean(byId?.[id]);
          const recorded = project.activeSessionId ?? project.sessionIds.at(-1);
          if (recorded !== undefined && exists(recorded)) return recorded;
          const workspace = await ctx.workspaces.create({ path: project.path });
          // DSH workspace titles are unique; project display names may repeat.
          const sessionId = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId);
          const renamed = await ctx.sessions.using(
            sessionId,
            { source: 'workspaceOperation' },
            reference => reference.binding.session.rename(project.name),
          );
          if (!renamed.ok) throw new Error(renamed.error.message);
          const response = await fetch(`${ROUTE}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: project.id, sessionId, workspaceId: workspace.workspaceId }),
          });
          if (!response.ok) throw new Error(`project session association failed: ${response.status}`);
          return sessionId;
        },
      };
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace', 'workspaces', 'sidebarRight'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        installChrome(ctx, t);
        ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
          { name: 'conversation.hero.workspace', priority: -1 },
          () => h('span', { className: 'rumi-project-workspace-marker', hidden: true }),
        ));
        const list = createProjectList(ctx);

        function ProjectCard({ project, t, onOpen }) {
          const [failedImage, setFailedImage] = React.useState(null);
          const updated = new Date(project.updatedAt);
          const when = Number.isNaN(updated.valueOf()) ? '' : updated.toLocaleDateString();
          return h('button', {
            className: 'rumi-project', type: 'button', onClick: () => onOpen(project),
            'aria-label': project.name,
          },
            h('span', { className: 'rumi-project-cover', 'aria-hidden': 'true' },
              project.thumbnailVersion && failedImage !== project.thumbnailVersion
                ? h('img', { src: `${ROUTE}/thumbnail?projectId=${encodeURIComponent(project.id)}&v=${encodeURIComponent(project.thumbnailVersion)}`,
                  alt: '', width: 480, height: 320, loading: 'lazy', decoding: 'async',
                  onError: () => setFailedImage(project.thumbnailVersion) })
                : h('span', { className: 'rumi-project-initial' })),
            h('p', { className: 'rumi-project-name' }, project.name),
            when === '' ? null : h('p', { className: 'rumi-project-meta' }, t('updated', { when })),
          );
        }

        function Gallery({ t }) {
          const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
          React.useEffect(() => { void list.load(); }, []);
          return h('section', { className: 'rumi-projects', 'aria-label': t('title') },
            h('div', { className: 'rumi-projects-head' },
              h('h1', { className: 'rumi-projects-title' }, t('title'))),
            state.error === '' ? null : h('p', { role: 'alert', className: 'rumi-projects-error' }, t('failed')),
            state.phase === 'ready' && state.projects.length === 0
              ? h('div', { className: 'rumi-projects-empty' },
                h('p', { className: 'rumi-projects-empty-title' }, t('empty')),
                h('p', { className: 'rumi-projects-empty-hint' }, t('emptyHint')))
              : h('div', { className: 'rumi-projects-grid' },
                state.projects.map(project => h(ProjectCard, { key: project.id, project, t, onOpen: p => { void list.open(p) } }))),
          );
        }

        function Leading({ usePanelInfo, useSidebar, toggleSidebar, toggleMode, t }) {
          const sidebar = useSidebar(value => value);
          const shown = sidebar !== 'closed' && sidebar !== 'none';
          const modeLabel = t(sidebar === 'full' ? 'regularPreview' : 'fullPreview');
          const toggleLabel = t(shown ? 'closePreview' : 'openPreview');
          const onHome = usePanelInfo(info => info.activePanelId === PANEL_ID);
          const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
          const project = state.projects.find(item => item.id === state.activeId);
          const [busy, setBusy] = React.useState(false);
          const create = async () => {
            if (busy) return;
            setBusy(true);
            try { await list.create(); } finally { setBusy(false); }
          };
          return h('header', { className: 'rumi-projects-leading' },
            onHome ? null : h('button', {
              type: 'button', className: 'rumi-glass', 'aria-label': t('back'), title: t('back'),
              onClick: () => list.close(),
            }, h(IconChevronLeftOutlineRegular, { size: 16 })),
            h('span', { className: 'rumi-header-title', title: onHome ? t('title') : project?.name },
              onHome ? t('title') : project?.name),
            h('div', { className: 'rumi-header-actions' },
              sidebar === 'none' ? null : h(React.Fragment, null,
                h(Tooltip, { label: modeLabel, side: 'bottom', portal: true, delayMs: 500 },
                  h('button', { type: 'button', className: 'rumi-glass', 'aria-label': modeLabel,
                    disabled: !shown, onClick: toggleMode }, h(ModeGlyph, { full: sidebar === 'full' }))),
                h(Tooltip, { label: toggleLabel, side: 'bottom', portal: true, delayMs: 500 },
                  h('button', { type: 'button', className: 'rumi-glass', 'aria-label': toggleLabel,
                    'aria-expanded': shown, onClick: toggleSidebar },
                    h(IconPanelLeftOutlineRegular, { size: 16, className: 'rumi-sidebar-glyph' })))),
              h('button', {
                type: 'button', className: 'rumi-glass rumi-header-new', 'aria-label': t('new'), title: t('new'),
                disabled: busy, onClick: create,
              }, h(IconPlusOutlineRegular, { size: 16 }))),
          );
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, Gallery));
        ctx.slots.inject('shell.leading', () => ctx.slots.register({
          name: 'shell.leading', locale: NS,
          inject: () => ({
            hooks: { sidebar: sidebarSource(ctx.sidebarRight) },
            toggleSidebar: () => ctx.sidebarRight.toggleExpanded(),
            toggleMode: () => {
              const target = ctx.sidebarRight.commandTarget(null);
              if (target !== undefined) ctx.sidebarRight.toggleFullscreen(target);
            },
          }),
        }, Leading));

        // Home is the splash and the stock navigation column has no place in
        // it. The frame publishes its collapsed state, and the layout service
        // offers only a toggle, so collapse once after the frame mounts. The
        // panel registration is live by then, which is why home is selected here
        // rather than in apply().
        let attempts = 0;
        const openHome = () => {
          if (document.querySelector('[data-shell-overlay]') === null && attempts++ < 300) {
            requestAnimationFrame(openHome);
            return;
          }
          if (document.querySelector('[data-sidebar-collapsed]') === null) ctx.layout.toggleSidebar();
          try {
            ctx.layout.selectPanel(PANEL_ID);
          } catch {
            // The panel is not live yet; the next boot selects it.
          }
        };
        requestAnimationFrame(openHome);
      },
    };
  },
});
