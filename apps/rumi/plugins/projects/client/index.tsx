/** Rumi projects — browser half: project gallery, window-chrome header, and DSH workspace session routing. */
import * as React from 'react'
import './styles.css'
import { en, NS, zh } from './locales.ts'
import { createProjectList, PANEL_ID, sidebarSource } from './project-list.ts'
import { createGallery } from './gallery.tsx'
import { createLeadingHeader } from './header.tsx'

export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace', 'workspaces', 'sidebarRight']

export function apply(ctx: any) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'rumi projects: copy')
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    { name: 'conversation.hero.workspace', priority: -1 },
    () => <span className="rumi-project-workspace-marker" hidden={true} />,
  ))

  const list = createProjectList(ctx)
  ctx.effect(() => list.connectEvents(), 'rumi projects: events')

  const Gallery = createGallery(list)
  const Leading = createLeadingHeader(list)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ hooks: { sessions: ctx.sessions.list } }),
  }, Gallery))

  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    children: { 'rumi.projects.toolbar': { kind: 'list', scope: 'root' } },
    inject: () => ({
      hooks: { sidebar: sidebarSource(ctx.sidebarRight) },
      updates: (window as any).dshDesktop?.updates,
      selectPanel: (id: string | null) => ctx.layout.selectPanel(id),
      toggleSidebar: () => ctx.sidebarRight.toggleExpanded(),
      toggleMode: () => {
        const target = ctx.sidebarRight.commandTarget(null)
        if (target !== undefined) ctx.sidebarRight.toggleFullscreen(target)
      },
    }),
  }, Leading))

  let attempts = 0
  const openHome = () => {
    if (document.querySelector('[data-shell-overlay]') === null && attempts++ < 300) {
      requestAnimationFrame(openHome)
      return
    }
    if (document.querySelector('[data-sidebar-collapsed]') === null) ctx.layout.toggleSidebar()
    try {
      ctx.layout.selectPanel(PANEL_ID)
    } catch {
      // The panel is not live yet; the next boot selects it.
    }
  }
  requestAnimationFrame(openHome)
}
