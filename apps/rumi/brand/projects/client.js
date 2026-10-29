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
    const { IconChevronLeftOutlineRegular, IconPlusOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const PANEL_ID = 'projects';
    const NS = 'rumi.projects';
    const ROUTE = '/api/rumi-projects';

    const en = {
      title: 'Projects',
      count: '{count} projects',
      new: 'New',
      back: 'All projects',
      empty: 'No projects yet.',
      emptyHint: 'Make one, then ask Rumi to help build it.',
      updated: 'Updated {when}',
      failed: 'That did not work. Try again.',
      untitled: 'Untitled project',
    };
    const zh = {
      title: '项目',
      count: '{count} 个项目',
      new: '新建',
      back: '所有项目',
      empty: '还没有项目',
      emptyHint: '先新建一个，然后请 Rumi 一起制作',
      updated: '更新于 {when}',
      failed: '没有成功，请再试一次',
      untitled: '未命名项目',
    };

    const STYLES = `
.rumi-projects{box-sizing:border-box;display:flex;flex-direction:column;gap:26px;width:100%;height:100%;min-height:0;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,48px) + 20px) 40px 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.rumi-projects-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.rumi-projects-title{margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em}
.rumi-projects-count{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:28px 24px}
.rumi-project{display:flex;flex-direction:column;gap:10px;padding:0;border:0;background:none;text-align:left;cursor:pointer;color:inherit}
.rumi-project-cover{box-sizing:border-box;position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);overflow:hidden;background:linear-gradient(160deg,hsl(var(--rumi-hue,220) 65% 62% / .26),hsl(var(--rumi-hue,220) 55% 58% / .10) 60%),var(--dsw-alias-bg-layer-2);transition:border-color 140ms ease,box-shadow 140ms ease,transform 140ms ease}
.rumi-project-initial{position:relative;font-size:64px;font-weight:500;letter-spacing:-0.04em;color:var(--dsw-alias-label-tertiary);opacity:.38;text-shadow:0 1px 0 rgba(255,255,255,.5)}
.rumi-project:hover .rumi-project-cover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2));box-shadow:0 8px 20px rgba(0,0,0,.07);transform:translateY(-1px)}
.rumi-project:active .rumi-project-cover{transform:none;box-shadow:none}
.rumi-project:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:18px}
.rumi-project-name{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rumi-project-meta{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-empty{display:flex;flex-direction:column;gap:6px;max-width:320px;margin:auto;text-align:center}
.rumi-projects-empty-title{margin:0;font-size:14px;font-weight:600}
.rumi-projects-empty-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.rumi-projects-leading{display:flex;align-items:center;gap:8px}
/* Liquid Glass: a translucent capsule over the window material. The specular
   inset and drop shade are material constants, not theme colors. */
.rumi-glass{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:9px;cursor:default;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 75%,transparent);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 1px 2px rgba(0,0,0,.10);transition:background-color 120ms ease}
.rumi-glass:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent)}
.rumi-glass:active{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 85%,transparent)}
.rumi-glass:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`;

    /** A stable, pleasant cover tint per project; product artwork, not theme state. */
    function hueOf(id) {
      let hash = 0;
      for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
      return hash;
    }

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
        async create(t) {
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: t('untitled') }),
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
          } catch {
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
          // The directory is an opaque id, so give the Workspace the project's own name.
          if (workspace.title !== project.name) await ctx.workspaces.rename(workspace.workspaceId, project.name);
          const sessionId = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId);
          await fetch(`${ROUTE}/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projectId: project.id, sessionId, workspaceId: workspace.workspaceId }),
          });
          return sessionId;
        },
      };
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        installChrome(ctx, t);
        const list = createProjectList(ctx);

        function ProjectCard({ project, t, onOpen }) {
          const updated = new Date(project.updatedAt);
          const when = Number.isNaN(updated.valueOf()) ? '' : updated.toLocaleDateString();
          return h('button', {
            className: 'rumi-project', type: 'button', onClick: () => onOpen(project),
            'aria-label': project.name, style: { '--rumi-hue': hueOf(project.id) },
          },
            h('span', { className: 'rumi-project-cover', 'aria-hidden': 'true' },
              h('span', { className: 'rumi-project-initial' }, project.name.trim().charAt(0).toUpperCase() || '?')),
            h('p', { className: 'rumi-project-name' }, project.name),
            when === '' ? null : h('p', { className: 'rumi-project-meta' }, t('updated', { when })),
          );
        }

        function Gallery({ t }) {
          const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
          React.useEffect(() => { void list.load(); }, []);
          return h('section', { className: 'rumi-projects', 'aria-label': t('title') },
            h('div', { className: 'rumi-projects-head' },
              h('h1', { className: 'rumi-projects-title' }, t('title')),
              state.phase === 'ready' ? h('p', { className: 'rumi-projects-count' }, t('count', { count: state.projects.length })) : null),
            state.error === '' ? null : h('p', { role: 'alert', className: 'rumi-projects-error' }, t('failed')),
            state.phase === 'ready' && state.projects.length === 0
              ? h('div', { className: 'rumi-projects-empty' },
                h('p', { className: 'rumi-projects-empty-title' }, t('empty')),
                h('p', { className: 'rumi-projects-empty-hint' }, t('emptyHint')))
              : h('div', { className: 'rumi-projects-grid' },
                state.projects.map(project => h(ProjectCard, { key: project.id, project, t, onOpen: p => { void list.open(p) } }))),
          );
        }

        function Leading({ usePanelInfo, t }) {
          const onHome = usePanelInfo(info => info.activePanelId === PANEL_ID);
          const busy = React.useRef(false);
          const run = (action) => {
            if (busy.current) return;
            busy.current = true;
            void Promise.resolve(action()).finally(() => { busy.current = false; });
          };
          // The frame reserves a 160px band beside the traffic lights for
          // icon-sized controls; the project name lives in the panel header.
          return h('div', { className: 'rumi-projects-leading' },
            onHome
              ? h('button', {
                type: 'button', className: 'rumi-glass', 'aria-label': t('new'), title: t('new'),
                onClick: () => run(() => list.create(t)),
              }, h(IconPlusOutlineRegular, { size: 16 }))
              : h('button', {
                type: 'button', className: 'rumi-glass', 'aria-label': t('back'), title: t('back'),
                onClick: () => list.close(),
              }, h(IconChevronLeftOutlineRegular, { size: 16 })),
          );
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, Gallery));
        ctx.slots.inject('shell.leading', () => ctx.slots.register({
          name: 'shell.leading', locale: NS,
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
