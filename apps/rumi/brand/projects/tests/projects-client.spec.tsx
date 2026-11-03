/** The gallery lists projects; opening one starts a session in the project directory. */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

type Loaded = {
  id: string
  factory: (require: (name: string) => unknown) => { inject: string[]; apply: (ctx: object) => void }
}

let loaded: Loaded | undefined
const disposers: (() => void | Promise<void>)[] = []

beforeAll(async () => {
  window.__ModuleLoader__ = { load: (entry: Loaded) => { loaded = entry } }
  await import('../client.js')
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  cleanup()
  document.documentElement.removeAttribute('data-rightbar-fullscreen')
  document.documentElement.removeAttribute('data-rightbar-collapsed')
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
afterAll(() => { delete window.__ModuleLoader__ })

function translate(key: string, params?: Record<string, unknown>) {
  const template = COPY[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const COPY: Record<string, string> = {
  title: 'Projects', new: 'New', back: 'All projects',
  openPreview: 'Open sidebar', closePreview: 'Close sidebar', fullPreview: 'Full view', regularPreview: 'Regular view',
  empty: 'No projects yet.', emptyHint: 'Make one, then ask Rumi to help build it.',
  updated: 'Updated {when}', failed: 'That did not work. Try again.', untitled: 'Untitled project',
  count: '{count} projects',
}

const project = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Dragon cup', path: '/Users/me/.rumi/workspace/p1',
  sessionIds: [], activeSessionId: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
  ...overrides,
})

const Icon = () => null

/** Apply the plugin into a fake context and return its handles. */
function fixture(host: { projects?: object[]; knownSessions?: Record<string, object>; activePanelId?: string | null; associationOk?: boolean } = {}) {
  type Injection = { hooks: { sidebar: HostObservable<string> }; toggleSidebar: () => void; toggleMode: () => void }
  const injections = new Map<string, () => Injection>()
  const entries = new Map<string, React.ComponentType<Record<string, unknown>>>()
  const register = () => () => {}
  const posts: { url: string; body: unknown }[] = []
  let listed = host.projects ?? []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      posts.push({ url: String(url), body })
      if (String(url).endsWith('/session')) return { ok: host.associationOk ?? true, status: 500, json: async () => ({ project: project() }) }
      const created = project({ id: 'p2', name: 'Untitled 1' })
      listed = [created, ...listed]
      return { ok: true, json: async () => ({ project: created }) }
    }
    return { ok: true, json: async () => ({ projects: listed }) }
  }))
  const panelInfo: HostObservable<{ activePanelId: string | null }> = {
    subscribe: () => () => {},
    getSnapshot: () => ({ activePanelId: host.activePanelId ?? null }),
  }
  const handles = {
    createWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', path: '/Users/me/.rumi/workspace/p1', title: 'p1' })),
    renameWorkspace: vi.fn(async () => ({ workspaceId: 'workspace-1', title: 'Dragon cup' })),
    renameSession: vi.fn(async (_title: string) => {}),
    connect: vi.fn(async () => 'session-new'),
    openSession: vi.fn(),
    selectPanel: vi.fn(),
    toggleSidebar: vi.fn(),
  }
  let expanded = true;
  const mounted = { getSnapshot: () => host.activePanelId === 'projects' ? undefined : 'session-1', subscribe: () => () => {} };
  const sidebar = {
    mounted, isExpanded: () => expanded,
    openTabIn: vi.fn(),
    toggleExpanded: vi.fn(() => { expanded = !expanded; document.documentElement.toggleAttribute('data-rightbar-collapsed', !expanded) }),
    commandTarget: vi.fn(() => ({ sessionId: 'session-1' })),
    toggleFullscreen: vi.fn(() => { document.documentElement.toggleAttribute('data-rightbar-fullscreen') }),
  };
  const ctx = {
    sidebarRight: sidebar,
    locale: { bind: () => translate, register },
    effect: (effect: () => (() => void | Promise<void>)) => { const dispose = effect(); disposers.push(dispose); return dispose },
    slots: {
      inject: (_name: string, registerEntry: () => (() => void)) => registerEntry(),
      register: (options: { name: string; key?: string; inject?: () => Injection }, component: React.ComponentType<Record<string, unknown>>) => {
        if (options.inject) injections.set(options.name, options.inject);
        entries.set(options.key === undefined ? options.name : `${options.name}:${options.key}`, component)
        return () => { entries.delete(options.name) }
      },
    },
    layout: { selectPanel: handles.selectPanel, toggleSidebar: handles.toggleSidebar, panelInfo },
    sessions: {
      using: vi.fn(async (_id: string, _options: object, callback: (reference: { binding: { session: { rename: typeof handles.renameSession } } }) => Promise<void>) => { await callback({ binding: { session: { rename: handles.renameSession } } }); return { ok: true } }),
      list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: host.knownSessions ?? {} }) },
    },
    workspaces: { create: handles.createWorkspace, rename: handles.renameWorkspace },
    uiWorkspace: { openSession: handles.openSession, connectWorkspace: handles.connect },
  }
  const definition = loaded!.factory(name => name === 'react' ? React : name === 'react-dom' ? ReactDOM : { IconPlusOutlineRegular: Icon, IconChevronLeftOutlineRegular: Icon, IconPanelLeftOutlineRegular: Icon, Tooltip: ({ children }: { children: React.ReactNode }) => children })
  definition.apply(ctx)
  return {
    ...handles, posts, sidebar,
    view: (key: string) => {
      const component = entries.get(key)!
      const usePanelInfo = ((selector: (value: { activePanelId: string | null }) => unknown) =>
        selector(panelInfo.getSnapshot())) satisfies SnapshotSelectorHook<{ activePanelId: string | null }>
      const injected = injections.get(key)?.();
      const source = injected?.hooks.sidebar;
      const useSidebar = (selector: (value: string) => unknown) => selector(React.useSyncExternalStore(source!.subscribe, source!.getSnapshot));
      return React.createElement(component, { t: translate, usePanelInfo, useSidebar, ...injected })
    },
  }
}

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

it('lists projects with their recency and opens one on click', async () => {
  const view = fixture({ projects: [project()] })
  render(view.view('main:projects'))
  await settle()
  expect(screen.getByText('Dragon cup')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dragon cup' }))
  await settle()
  expect(view.createWorkspace).toHaveBeenCalledWith({ path: '/Users/me/.rumi/workspace/p1' })
  expect(view.renameWorkspace).not.toHaveBeenCalled()
  expect(view.connect).toHaveBeenCalledWith('workspace-1')
  expect(view.openSession).toHaveBeenCalledWith('session-new')
  expect(view.sidebar.openTabIn).toHaveBeenCalledWith('session-new', 'print-studio')
  expect(view.selectPanel).toHaveBeenCalledWith(null)
  expect(view.posts.at(-1)?.body).toEqual({ projectId: 'p1', sessionId: 'session-new', workspaceId: 'workspace-1' })
})

it('reuses the session a project already recorded', async () => {
  const known = project({ sessionIds: ['session-1'], activeSessionId: 'session-1' })
  const view = fixture({ projects: [known], knownSessions: { 'session-1': { sessionId: 'session-1' } } })
  render(view.view('main:projects'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Dragon cup' }))
  await settle()
  expect(view.connect).not.toHaveBeenCalled()
  expect(view.openSession).toHaveBeenCalledWith('session-1')
  expect(view.sidebar.openTabIn).toHaveBeenCalledWith('session-1', 'print-studio')
})

it('shows an empty gallery with an invitation', async () => {
  const view = fixture({ projects: [] })
  render(view.view('main:projects'))
  await settle()
  expect(screen.getByText(COPY.empty)).toBeTruthy()
  expect(screen.getByText(COPY.emptyHint)).toBeTruthy()
})

it('creates a project from the New control and opens it', async () => {
  const view = fixture({ projects: [], activePanelId: 'projects' })
  render(view.view('shell.leading'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: COPY.new }))
  await settle()
  expect(view.posts[0]?.body).toEqual({})
  expect(view.renameSession).toHaveBeenCalledWith('Untitled 1')
  expect(view.openSession).toHaveBeenCalled()
  expect(view.sidebar.openTabIn).toHaveBeenCalledWith('session-new', 'print-studio')
})

it('returns to the gallery without ending the session', async () => {
  const view = fixture({ projects: [project()] })
  render(view.view('shell.leading'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: COPY.back }))
  expect(view.selectPanel).toHaveBeenCalledWith('projects')
})

it('collapses the navigation column and opens home once the frame exists', async () => {
  const frame = document.createElement('div')
  frame.setAttribute('data-shell-overlay', '')
  document.body.append(frame)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0 })
  const view = fixture()
  expect(view.toggleSidebar).toHaveBeenCalledOnce()
  expect(view.selectPanel).toHaveBeenCalledWith('projects')
  frame.remove()
})

it('leaves an already collapsed column alone', async () => {
  const frame = document.createElement('div')
  frame.setAttribute('data-shell-overlay', '')
  frame.setAttribute('data-sidebar-collapsed', '')
  document.body.append(frame)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0 })
  const view = fixture()
  expect(view.toggleSidebar).not.toHaveBeenCalled()
  expect(view.selectPanel).toHaveBeenCalledWith('projects')
  frame.remove()
})

it('opens projects even when their display name is already a workspace title', async () => {
  const view = fixture({ projects: [project({ name: 'Untitled project' })] })
  view.renameWorkspace.mockRejectedValue(new Error('workspace/name-conflict'))
  render(view.view('main:projects'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Untitled project' }))
  await settle()
  expect(view.openSession).toHaveBeenCalledWith('session-new')
  expect(view.sidebar.openTabIn).toHaveBeenCalledWith('session-new', 'print-studio')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the gallery open when saving the session association fails', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const view = fixture({ projects: [project()], associationOk: false })
    render(view.view('main:projects'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Dragon cup' }))
    await settle()
    expect(view.openSession).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(COPY.failed)
    expect(report).toHaveBeenCalled()
  } finally {
    report.mockRestore()
  }
})

it('leaves project selection on the home page instead of the conversation hero', () => {
  const view = fixture({ projects: [] })
  render(view.view('conversation.hero.workspace'))
  expect(document.body.textContent).toBe('')
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('shows the opened project name in the header and keeps New available', async () => {
  const view = fixture({ projects: [project({ name: 'Dragon cup' })] })
  render(<>{view.view('main:projects')}{view.view('shell.leading')}</>)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Dragon cup' }))
  await settle()
  expect(document.querySelector('.rumi-header-title')?.textContent).toBe('Dragon cup')
  expect(screen.getByRole('button', { name: COPY.new })).toBeTruthy()
  expect(screen.getByRole('button', { name: COPY.back })).toBeTruthy()
})

it('keeps sidebar controls before New and reopens the collapsed sidebar', async () => {
  const view = fixture({ projects: [project()] })
  render(view.view('shell.leading'))
  expect([...document.querySelectorAll('.rumi-header-actions button')].map(button => button.getAttribute('aria-label')))
    .toEqual(['Full view', 'Close sidebar', 'New'])
  fireEvent.click(screen.getByRole('button', { name: 'Full view' }))
  await settle()
  expect(view.sidebar.toggleFullscreen).toHaveBeenCalledWith({ sessionId: 'session-1' })
  fireEvent.click(screen.getByRole('button', { name: 'Regular view' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
  await settle()
  expect(screen.getByRole('button', { name: 'Full view' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
  await settle()
  expect(screen.getByRole('button', { name: 'Close sidebar' }).getAttribute('aria-expanded')).toBe('true')
  expect(view.sidebar.toggleExpanded).toHaveBeenCalledTimes(2)
})

it('omits sidebar controls on the project gallery', () => {
  const view = fixture({ activePanelId: 'projects' })
  render(view.view('shell.leading'))
  expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Close sidebar' })).toBeNull()
  expect(screen.getByRole('button', { name: 'New' })).toBeTruthy()
})

it('loads saved covers as lazy images and falls back when a cover cannot be read', async () => {
  const view = fixture({ projects: [project({ thumbnailVersion: '42' })] })
  const { container } = render(view.view('main:projects'))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const image = container.querySelector('.rumi-project-cover img')!
  expect(image.getAttribute('src')).toBe('/api/rumi-projects/thumbnail?projectId=p1&v=42')
  expect(image.getAttribute('loading')).toBe('lazy')
  expect(container.querySelector('canvas')).toBeNull()
  fireEvent.error(image)
  expect(container.querySelector('.rumi-project-cover img')).toBeNull()
  expect(container.querySelector('.rumi-project-initial')).not.toBeNull()
})
