import { flushSync } from 'react-dom'

export const PANEL_ID = 'projects'
export const ROUTE = '/api/rumi-projects'

export interface ProjectRecord {
  id: string
  name: string
  nameSource?: 'default' | 'auto' | 'user'
  path: string
  sessionIds: string[]
  activeSessionId: string | null
  thumbnailVersion?: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectListSnapshot {
  phase: 'loading' | 'ready' | 'failed'
  projects: ProjectRecord[]
  error: string
  activeId: string | null
}

/** Apply the new page's geometry in one layout pass before re-enabling sidebar transitions. */
export function commitProjectNavigation(commit: () => void): void {
  const frame = document.querySelector('[data-shell-overlay]')?.parentElement
  frame?.setAttribute('data-rumi-project-navigation', '')
  try {
    commit()
  } finally {
    if (frame) {
      frame.getBoundingClientRect()
      frame.removeAttribute('data-rumi-project-navigation')
    }
  }
}

function sessionSummary(sessions: any, id: string) {
  return sessions instanceof Map ? sessions.get(id) : sessions?.[id]
}

export function projectActivity(project: ProjectRecord, sessions: any): number {
  const recorded = Math.max(Date.parse(project.updatedAt) || 0, Date.parse(project.createdAt) || 0)
  return project.sessionIds.reduce((latest, id) => Math.max(latest, sessionSummary(sessions, id)?.updatedAt ?? 0), recorded)
}

/** Observable source tracking the right sidebar's effective mode, including narrow windows. */
export function sidebarSource(sidebar: any) {
  return {
    getSnapshot: () => {
      if (sidebar.mounted.getSnapshot() === undefined) return 'none'
      if (!sidebar.isExpanded()) return 'closed'
      return document.querySelector('[data-rightbar-fullscreen]') ? 'full' : 'regular'
    },
    subscribe: (listener: () => void) => {
      const observer = new MutationObserver(listener)
      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-rightbar-fullscreen', 'data-rightbar-collapsed', 'data-sidebar-right-open'],
      })
      const unmount = sidebar.mounted.subscribe(listener)
      return () => { observer.disconnect(); unmount() }
    },
  }
}

/** Shared project list store coordinating gallery, header, SSE updates, and DSH workspace sessions. */
export function createProjectList(ctx: any) {
  let snapshot: ProjectListSnapshot = { phase: 'loading', projects: [], error: '', activeId: null }
  const listeners = new Set<() => void>()
  const publish = (next: Partial<ProjectListSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    async load() {
      try {
        const response = await fetch(ROUTE, { cache: 'no-store' })
        if (!response.ok) throw new Error(`projects: ${response.status}`)
        publish({ phase: 'ready', projects: (await response.json()).projects ?? [], error: '' })
      } catch {
        publish({ phase: 'failed', error: 'load' })
      }
    },
    async create() {
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
        if (!response.ok) throw new Error(`projects: ${response.status}`)
        const { project } = await response.json()
        publish({ projects: [project, ...snapshot.projects], error: '' })
        await this.open(project)
        return project
      } catch {
        publish({ error: 'create' })
        return null
      }
    },
    async open(project: ProjectRecord) {
      try {
        const { sessionId, workspaceId } = await this.sessionFor(project)
        const response = await fetch(`${ROUTE}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: project.id, sessionId, workspaceId }),
        })
        if (!response.ok) throw new Error(`project session association failed: ${response.status}`)
        const { project: opened } = await response.json()
        commitProjectNavigation(() => {
          flushSync(() => {
            ctx.uiWorkspace.openSession(sessionId)
            ctx.layout.selectPanel(null)
            publish({
              activeId: project.id,
              error: '',
              projects: snapshot.projects.map(item => item.id === opened.id ? { ...item, ...opened } : item),
            })
          })
          const sidebar = ctx.sidebarRight
          const dockTabId = sidebar.commandTarget(null)?.tabId
          const previewVisible = sidebar.isExpanded() && sidebar.tabsIn(sessionId).some((tab: any) =>
            tab.id === dockTabId && tab.kind === 'print-studio')
          if (!previewVisible) flushSync(() => sidebar.openTabIn(sessionId, 'print-studio'))
        })
      } catch (error) {
        console.error('Rumi project opening failed', error)
        publish({ error: 'open' })
      }
    },
    async remove(project: ProjectRecord) {
      try {
        const response = await fetch(`${ROUTE}?projectId=${encodeURIComponent(project.id)}`, { method: 'DELETE' })
        if (!response.ok) throw new Error(`projects: ${response.status}`)
        publish({
          projects: snapshot.projects.filter(item => item.id !== project.id),
          activeId: snapshot.activeId === project.id ? null : snapshot.activeId,
          error: '',
        })
        return true
      } catch {
        publish({ error: 'delete' })
        return false
      }
    },
    connectEvents() {
      if (typeof EventSource !== 'function') return () => {}
      const source = new EventSource(`${ROUTE}/events`)
      const onUpdated = (event: MessageEvent) => {
        if (typeof event.data !== 'string' || event.data.length > 16_384) return
        let payload: any
        try {
          payload = JSON.parse(event.data)
        } catch (error) {
          if (error instanceof SyntaxError) return
          throw error
        }
        const updated = payload?.project
        if (typeof updated?.id !== 'string' || typeof updated?.name !== 'string') return
        if (!snapshot.projects.some(item => item.id === updated.id)) return
        publish({
          projects: snapshot.projects.map(item => item.id === updated.id
            ? { ...item, ...updated, thumbnailVersion: updated.thumbnailVersion ?? item.thumbnailVersion }
            : item),
        })
      }
      source.addEventListener('project-updated', onUpdated as EventListener)
      return () => {
        source.removeEventListener('project-updated', onUpdated as EventListener)
        source.close()
      }
    },
    close() {
      commitProjectNavigation(() => flushSync(() => ctx.layout.selectPanel(PANEL_ID)))
    },
    async sessionFor(project: ProjectRecord) {
      const { byId } = ctx.sessions.list.getSnapshot()
      const recorded = project.activeSessionId ?? project.sessionIds.at(-1)
      if (recorded !== undefined && sessionSummary(byId, recorded)) return { sessionId: recorded }
      const workspace = await ctx.workspaces.create({ path: project.path })
      const sessionId = await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
      const isDefaultName = project.nameSource === 'default'
        || (project.nameSource === undefined && /^Untitled \d+$/u.test(project.name ?? ''))
      if (!isDefaultName) {
        const renamed = await ctx.sessions.using(
          sessionId,
          { source: 'workspaceOperation' },
          (reference: any) => reference.binding.session.rename(project.name),
        )
        if (!renamed.ok) throw new Error(renamed.error.message)
      }
      return { sessionId, workspaceId: workspace.workspaceId }
    },
  }
}

export type ProjectList = ReturnType<typeof createProjectList>
