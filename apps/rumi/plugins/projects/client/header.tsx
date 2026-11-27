import * as React from 'react'
import {
  IconChevronLeftOutlineRegular,
  IconDownloadOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PANEL_ID, type ProjectList } from './project-list.ts'

function UpdateBadge({ updates, t }: { updates: any; t: (key: string) => string }) {
  const [state, setState] = React.useState<any>(null)
  React.useEffect(() => {
    if (!updates) return
    let current = true
    let received = false
    const unsubscribe = updates.subscribe((value: any) => {
      received = true
      if (current) setState(value)
    })
    void updates.status().then((value: any) => {
      if (current && !received) setState(value)
    }).catch((error: unknown) => { console.warn('Rumi update status is unavailable', error) })
    return () => { current = false; unsubscribe() }
  }, [updates])

  if (state?.phase !== 'downloading' && state?.phase !== 'verifying' && state?.phase !== 'ready') return null
  const ready = state.phase === 'ready'
  const downloading = state.phase === 'downloading'
  const percent = Number.isFinite(state.percent) ? state.percent : 0
  const label = ready ? t('updateRestartLabel') : t(downloading ? 'updateDownloading' : 'updateVerifying')

  if (ready) {
    return (
      <button
        type="button"
        className="rumi-glass rumi-update-badge"
        aria-label={label}
        onClick={() => { void updates.restart().catch((error: unknown) => { console.error('Rumi could not restart to update', error) }) }}
      >
        {t('updateRestart')}
      </button>
    )
  }

  return (
    <span
      className="rumi-glass rumi-update-badge"
      aria-label={label}
      {...(downloading
        ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent }
        : { role: 'status' })}
    >
      {downloading ? (
        <>
          <span className="rumi-update-progress" aria-hidden={true} style={{ '--rumi-progress': `${percent}%` } as React.CSSProperties}>
            <IconDownloadOutlineRegular size={9} />
          </span>
          {`${percent}%`}
        </>
      ) : t('updateVerifying')}
    </span>
  )
}

function ModeGlyph({ full }: { full: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden={true}>
      {full ? (
        <>
          <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
          <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
        </>
      ) : (
        <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
      )}
    </svg>
  )
}

function PluginsGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden={true}>
      <path d="M19 13h1.5a2.5 2.5 0 0 0 0-5H19V5a2 2 0 0 0-2-2h-3v1.5a2.5 2.5 0 0 1-5 0V3H5a2 2 0 0 0-2 2v4h1.5a2.5 2.5 0 0 1 0 5H3v5a2 2 0 0 0 2 2h4v-1.5a2.5 2.5 0 0 1 5 0V21h3a2 2 0 0 0 2-2Z" />
    </svg>
  )
}

/** Build the window-chrome leading header bound to the shared project list. */
export function createLeadingHeader(list: ProjectList) {
  return function Leading({ usePanelInfo, useSidebar, toggleSidebar, toggleMode, selectPanel, renderSlot, updates, t }: any) {
    const sidebar = useSidebar((value: string) => value)
    const shown = sidebar !== 'closed' && sidebar !== 'none'
    const modeLabel = t(sidebar === 'full' ? 'regularPreview' : 'fullPreview')
    const toggleLabel = t(shown ? 'closePreview' : 'openPreview')
    const activePanel = usePanelInfo((info: any) => info.activePanelId)
    const onHome = activePanel === PANEL_ID
    const [page, setPage] = React.useState<{ id: string; title: string; origin: string | null } | null>(null)
    const atPage = page !== null && page.id === activePanel
    const openPage = (id: string, title: string) => {
      if (atPage && id === activePanel) {
        selectPanel(page.origin)
        setPage(null)
        return
      }
      setPage({ id, title, origin: activePanel })
      selectPanel(id)
    }
    const state = React.useSyncExternalStore(list.subscribe, list.getSnapshot)
    const project = state.projects.find(item => item.id === state.activeId)
    const [busy, setBusy] = React.useState(false)
    const create = async () => {
      if (busy) return
      setBusy(true)
      try { await list.create() } finally { setBusy(false) }
    }
    const [headerIconFailed, setHeaderIconFailed] = React.useState(false)
    const title = atPage ? page.title : onHome ? t('title') : project?.name
    const back = t(atPage ? 'goBack' : 'back')

    return (
      <header className="rumi-projects-leading">
        <div className="rumi-header-start">
          {onHome ? null : (
            <button
              type="button"
              className="rumi-glass"
              aria-label={back}
              title={back}
              onClick={() => atPage ? openPage(page.id, page.title) : list.close()}
            >
              <IconChevronLeftOutlineRegular size={16} />
            </button>
          )}
          <span className="rumi-header-title" title={title}>{title}</span>
        </div>
        <div className="rumi-header-brand" aria-hidden="true">
          {headerIconFailed ? null : (
            <img
              src="/api/rumi-brand/icon.png"
              alt=""
              height={36}
              className="rumi-header-icon"
              draggable={false}
              onError={() => setHeaderIconFailed(true)}
            />
          )}
        </div>
        <div className="rumi-header-actions">
          <UpdateBadge updates={updates} t={t} />
          {sidebar === 'none' ? null : (
            <>
              <Tooltip label={modeLabel} side="bottom" portal={true} delayMs={500}>
                <button type="button" className="rumi-glass" aria-label={modeLabel} disabled={!shown} onClick={toggleMode}>
                  <ModeGlyph full={sidebar === 'full'} />
                </button>
              </Tooltip>
              <Tooltip label={toggleLabel} side="bottom" portal={true} delayMs={500}>
                <button type="button" className="rumi-glass" aria-label={toggleLabel} aria-expanded={shown} onClick={toggleSidebar}>
                  <IconPanelLeftOutlineRegular size={16} className="rumi-sidebar-glyph" />
                </button>
              </Tooltip>
            </>
          )}
          {renderSlot('rumi.projects.toolbar', { openPage, activePanel })}
          <Tooltip label={t('plugins')} side="bottom" portal={true} delayMs={500}>
            <button type="button" className="rumi-glass" aria-label={t('plugins')} onClick={() => selectPanel('plugins')}>
              <PluginsGlyph />
            </button>
          </Tooltip>
          <button type="button" className="rumi-glass rumi-header-new" aria-label={t('new')} title={t('new')} disabled={busy} onClick={create}>
            <IconPlusOutlineRegular size={16} />
          </button>
        </div>
      </header>
    )
  }
}
