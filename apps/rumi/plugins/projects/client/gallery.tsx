import * as React from 'react'
import { IconFolderOpenOutlineRegular, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLens } from './liquid-glass.ts'
import { projectActivity, ROUTE, type ProjectList, type ProjectRecord } from './project-list.ts'

function Cover({ project }: { project: ProjectRecord }) {
  const [failedImage, setFailedImage] = React.useState<string | null>(null)
  return (
    <span className="rumi-project-cover" aria-hidden="true">
      {project.thumbnailVersion && failedImage !== project.thumbnailVersion ? (
        <img
          src={`${ROUTE}/thumbnail?projectId=${encodeURIComponent(project.id)}&v=${encodeURIComponent(project.thumbnailVersion)}`}
          alt=""
          width={480}
          height={320}
          loading="lazy"
          decoding="async"
          onError={() => setFailedImage(project.thumbnailVersion ?? null)}
        />
      ) : (
        <span className="rumi-project-initial" />
      )}
    </span>
  )
}

function ProjectCard({ project, activity, t, onOpen, onMenu }: {
  project: ProjectRecord
  activity: number
  t: (key: string, params?: Record<string, string>) => string
  onOpen: (project: ProjectRecord) => void
  onMenu: (project: ProjectRecord, x: number, y: number, opener: HTMLButtonElement) => void
}) {
  const when = activity === 0 ? '' : new Date(activity).toLocaleDateString()
  return (
    <button
      className="rumi-project"
      type="button"
      onClick={() => onOpen(project)}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(project, event.clientX, event.clientY, event.currentTarget)
      }}
      aria-label={project.name}
    >
      <Cover project={project} />
      <p className="rumi-project-name">{project.name}</p>
      {when === '' ? null : <p className="rumi-project-meta">{t('lastActive', { when })}</p>}
    </button>
  )
}

/** Context menu anchored at the pointer, clamped inside the viewport. */
function ProjectMenu({ name, x, y, t, onOpen, onDelete, onClose }: {
  name: string
  x: number
  y: number
  t: (key: string) => string
  onOpen: () => void
  onDelete: () => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState({ x, y })
  useLens(ref, 4)

  React.useLayoutEffect(() => {
    const menu = ref.current!
    const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]')
    items[0]?.focus()
    const margin = 8
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin)),
    })
  }, [x, y])

  React.useEffect(() => {
    const outside = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const close = () => onClose()
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
    } else if (event.key === 'Tab') {
      onClose()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={name}
      className="rumi-menu rumi-lq"
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
    >
      <button type="button" role="menuitem" className="rumi-menu-item" onClick={onOpen}>
        <IconFolderOpenOutlineRegular size={16} />
        {t('open')}
      </button>
      <div role="separator" className="rumi-menu-separator" />
      <button type="button" role="menuitem" className="rumi-menu-item rumi-menu-item-danger" onClick={onDelete}>
        <IconTrashOutlineRegular size={16} />
        {t('delete')}
      </button>
    </div>
  )
}

function DeleteAlert({ project, busy, t, onCancel, onConfirm }: {
  project: ProjectRecord
  busy: boolean
  t: (key: string, params?: Record<string, string>) => string
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  useLens(ref, 9)
  const titleId = React.useId()
  const messageId = React.useId()

  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.rumi-alert-cancel')?.focus()
  }, [])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) onCancel()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const buttons = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      if (buttons.length === 0) return
      const index = buttons.indexOf(document.activeElement as HTMLElement)
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
  }

  return (
    <div
      className="rumi-scrim"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}
    >
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        className="rumi-alert rumi-lq"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={onKeyDown}
      >
        <div className="rumi-alert-cover"><Cover project={project} /></div>
        <p id={titleId} className="rumi-alert-title">{t('deleteTitle', { name: project.name })}</p>
        <p id={messageId} className="rumi-alert-message">{t('deleteMessage')}</p>
        <div className="rumi-alert-actions">
          <button type="button" className="rumi-alert-button rumi-alert-cancel" disabled={busy} onClick={onCancel}>{t('cancel')}</button>
          <button type="button" className="rumi-alert-button rumi-alert-delete" disabled={busy} onClick={onConfirm}>{t('delete')}</button>
        </div>
      </div>
    </div>
  )
}

/** Build the project gallery main panel bound to the shared project list. */
export function createGallery(list: ProjectList) {
  return function Gallery({ t, useSessions }: any) {
    const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot)
    const activityTimes: number[] = useSessions(
      ({ byId }: any) => state.projects.map(project => projectActivity(project, byId)),
      (left: number[], right: number[]) => left.length === right.length && left.every((time, index) => time === right[index]),
    )
    const ordered = state.projects
      .map((project, index) => ({ project, activity: activityTimes[index] ?? 0 }))
      .sort((left, right) => right.activity - left.activity)

    const [menu, setMenu] = React.useState<{ project: ProjectRecord; x: number; y: number; opener: HTMLButtonElement } | null>(null)
    const [confirming, setConfirming] = React.useState<{ project: ProjectRecord; opener: HTMLButtonElement; busy: boolean } | null>(null)

    React.useEffect(() => { void list.load() }, [])

    const closeMenu = React.useCallback((restoreFocus?: boolean) => {
      setMenu(current => {
        if (restoreFocus === true && current?.opener.isConnected) current.opener.focus()
        return null
      })
    }, [])

    const cancel = () => {
      const opener = confirming?.opener
      setConfirming(null)
      if (opener?.isConnected) opener.focus()
    }

    const confirm = async () => {
      if (!confirming) return
      setConfirming(current => current ? { ...current, busy: true } : null)
      await list.remove(confirming.project)
      setConfirming(null)
    }

    return (
      <section className="rumi-projects" aria-label={t('title')}>
        <div className="rumi-projects-head">
          <h1 className="rumi-projects-title">{t('title')}</h1>
        </div>
        {state.error === '' ? null : <p role="alert" className="rumi-projects-error">{t('failed')}</p>}
        {state.phase === 'ready' && state.projects.length === 0 ? (
          <div className="rumi-projects-empty">
            <p className="rumi-projects-empty-title">{t('empty')}</p>
            <p className="rumi-projects-empty-hint">{t('emptyHint')}</p>
          </div>
        ) : (
          <div className="rumi-projects-grid">
            {ordered.map(({ project, activity }) => (
              <ProjectCard
                key={project.id}
                project={project}
                activity={activity}
                t={t}
                onOpen={p => { void list.open(p) }}
                onMenu={(p, x, y, opener) => setMenu({ project: p, x, y, opener })}
              />
            ))}
          </div>
        )}
        {menu === null ? null : (
          <ProjectMenu
            key={`${menu.project.id}:${menu.x}:${menu.y}`}
            name={menu.project.name}
            x={menu.x}
            y={menu.y}
            t={t}
            onClose={closeMenu}
            onOpen={() => { setMenu(null); void list.open(menu.project) }}
            onDelete={() => { setMenu(null); setConfirming({ project: menu.project, opener: menu.opener, busy: false }) }}
          />
        )}
        {confirming === null ? null : (
          <DeleteAlert project={confirming.project} busy={confirming.busy} t={t} onCancel={cancel} onConfirm={confirm} />
        )}
      </section>
    )
  }
}
