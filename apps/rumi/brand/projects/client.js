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
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const PANEL_ID = 'projects';
    const NS = 'rumi.projects';
    const ROUTE = '/api/rumi-projects';

    const en = {
      title: 'Projects',
      new: 'New',
      close: 'Close',
      empty: 'No projects yet.',
      emptyHint: 'Make one, then ask Rumi to help build it.',
      updated: 'Updated {when}',
      failed: 'That did not work. Try again.',
      untitled: 'Untitled project',
    };
    const zh = {
      title: '项目',
      new: '新建',
      close: '关闭',
      empty: '还没有项目',
      emptyHint: '先新建一个，然后请 Rumi 一起制作',
      updated: '更新于 {when}',
      failed: '没有成功，请再试一次',
      untitled: '未命名项目',
    };

    const STYLES = `
.rumi-projects{display:flex;flex-direction:column;gap:20px;width:100%;height:100%;min-height:0;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,48px) + 16px) 40px 40px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.rumi-projects-head{display:flex;align-items:baseline;gap:12px}
.rumi-projects-title{margin:0;font-size:20px;font-weight:600;letter-spacing:-0.01em}
.rumi-projects-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px}
.rumi-project{display:flex;flex-direction:column;gap:10px;padding:0;border:0;background:none;text-align:left;cursor:pointer;color:inherit}
.rumi-project-cover{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.rumi-project-cover::after{content:"";position:absolute;inset:0;background:linear-gradient(160deg,var(--dsw-alias-bg-layer-3),transparent 60%)}
.rumi-project-initial{position:relative;font-size:44px;font-weight:600;color:var(--dsw-alias-label-tertiary);opacity:.55}
.rumi-project:hover .rumi-project-cover{border-color:var(--dsw-alias-brand-primary)}
.rumi-project:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:16px}
.rumi-project-name{font-size:14px;font-weight:600;margin:0}
.rumi-project-meta{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-empty{display:flex;flex-direction:column;gap:6px;max-width:320px;margin:auto;text-align:center}
.rumi-projects-empty-title{margin:0;font-size:14px;font-weight:600}
.rumi-projects-empty-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rumi-projects-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.rumi-projects-leading{display:flex;align-items:center;gap:8px}
.rumi-projects-leading button{height:28px;padding:0 12px;border-radius:8px;font-size:12px}
.rumi-projects-leading-name{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
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
            'aria-label': project.name,
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
            h('div', { className: 'rumi-projects-head' }, h('h1', { className: 'rumi-projects-title' }, t('title'))),
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
          const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
          const active = state.projects.find(project => project.id === state.activeId);
          const busy = React.useRef(false);
          const run = (action) => {
            if (busy.current) return;
            busy.current = true;
            void Promise.resolve(action()).finally(() => { busy.current = false; });
          };
          return h('div', { className: 'rumi-projects-leading' },
            onHome
              ? h(Button, {
                size: 'sm', variant: 'outline',
                onClick: () => run(() => list.create(t)),
              }, t('new'))
              : h(React.Fragment, null,
                h('span', { className: 'rumi-projects-leading-name' }, active?.name ?? ''),
                h(Button, { size: 'sm', variant: 'outline', onClick: () => list.close() }, t('close'))),
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
