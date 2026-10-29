/**
 * The mesh preview's browser half: registrations, the scene subscription, and
 * the pane that hands the scene to the viewport.
 *
 * It loads datablock bytes once per mesh, then follows scene changes as
 * placement only. Nothing here imports three: the viewport is a separate
 * module, and this half never measures or transforms geometry.
 */
import { parseStl } from './stl.js'
import { createViewport } from './viewport/index.js'
import { placeMesh } from './transform.js'
import { en, zh } from './locales.js'
import stylesheet from './viewer.module.css'

const NS = 'rumi.printViewer'
const ID = '@rumi/print-studio/viewer'
const KIND = 'print-studio'
const ROUTE = '/api/print-studio/viewer'
/** How often the pane asks whether the conversation's scene changed. */
const POLL_MS = 2000
/** Conversations whose scene state stays in memory. */
const MAX_SCENES = 8
/** Datablocks cached across conversations; one scene needs only a few. */
const MAX_GEOMETRY = 32
const EMPTY = Object.freeze({ scene: null, view: null })

/**
 * Register the viewer into an already-mounted client plugin.
 * @param {object} ctx - Client plugin context with locale, slots, sidebar services, and document previews.
 * @param {object} React - The shell's React instance.
 * @param {object} primitives - Shared primitives from `@deepseek-ai/dsh-client-ui-primitives`.
 * @returns {void}
 */
export function installViewer(ctx, React, primitives) {
  const h = React.createElement
  const { PluginArtworkDefault } = primitives
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'print viewer: copy')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'print viewer: styles')

  const snapshots = new Map()
  const opened = new Map()
  const geometry = new Map()
  const listeners = new Set()
  const notify = () => { for (const listener of listeners) listener() }
  const read = sessionId => snapshots.get(sessionId) ?? EMPTY
  const publish = (sessionId, next) => {
    const current = snapshots.get(sessionId)
    if (current === undefined && next === EMPTY) return
    if (current !== undefined && current.scene === next.scene && current.view === next.view) return
    snapshots.delete(sessionId)
    if (next !== EMPTY) snapshots.set(sessionId, next)
    while (snapshots.size > MAX_SCENES) snapshots.delete(snapshots.keys().next().value)
    notify()
  }
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }

  ctx.effect(() => {
    const controller = new AbortController()
    let timer
    let pending
    const stopped = () => controller.signal.aborted
    const readScene = async (sessionId) => {
      const response = await fetch(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('preview state unavailable')
      return (await response.json()).scene ?? null
    }
    const readPositions = async (sessionId, datablockId) => {
      const response = await fetch(
        `${ROUTE}/model?sessionId=${encodeURIComponent(sessionId)}&datablockId=${encodeURIComponent(datablockId)}`,
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error('preview bytes unavailable')
      return parseStl(await response.arrayBuffer())
    }
    const viewOf = scene => ({
      volume: scene.volume,
      objects: scene.objects.map(object => ({
        id: object.id,
        datablockId: object.datablockId,
        positions: geometry.get(object.datablockId),
        matrix: object.matrix,
        blocked: object.blocked,
      })),
    })
    const tick = async () => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (sessionId === undefined) return
      const current = snapshots.get(sessionId)
      const scene = await readScene(sessionId)
      if (scene === null) { publish(sessionId, EMPTY); return }
      const unchanged = current?.scene != null && current.scene.revision === scene.revision
      const complete = scene.objects.every(object => geometry.has(object.datablockId))
      if (unchanged && complete && current.view !== null) return
      // Publish the scene before its geometry so a failed fetch is reportable.
      if (!complete) publish(sessionId, { scene, view: null })
      for (const object of scene.objects) {
        if (geometry.has(object.datablockId)) continue
        if (geometry.size >= MAX_GEOMETRY) geometry.clear()
        geometry.set(object.datablockId, await readPositions(sessionId, object.datablockId))
      }
      if (stopped()) return
      publish(sessionId, { scene, view: viewOf(scene) })
      if (scene.objects.length === 0 || opened.get(sessionId) === scene.revision) return
      opened.set(sessionId, scene.revision)
      ctx.sidebarRight.openTabIn(sessionId, KIND)
    }
    const run = () => {
      pending = tick().catch(() => {
        if (stopped()) return
        const sessionId = ctx.sidebarRight.mounted.getSnapshot()
        const current = sessionId === undefined ? undefined : snapshots.get(sessionId)
        if (current?.scene) publish(sessionId, { scene: { ...current.scene, failed: true }, view: current.view })
      }).finally(() => { if (!stopped()) timer = setTimeout(run, POLL_MS) })
    }
    run()
    return async () => {
      controller.abort()
      clearTimeout(timer)
      await pending
      snapshots.clear()
      opened.clear()
      geometry.clear()
      listeners.clear()
    }
  }, 'print viewer: scene polling')

  /** The canvas and its three.js adapter; mounted only while the scene has objects. */
  function Stage({ view, t }) {
    const holder = React.useRef(null)
    const viewport = React.useRef(null)
    const [failed, setFailed] = React.useState(false)
    React.useEffect(() => {
      try {
        viewport.current = createViewport(holder.current, () => setFailed(true))
        setFailed(false)
      } catch {
        // Without WebGL the pane still carries the status and the failure copy.
        setFailed(true)
      }
      return () => { viewport.current?.dispose(); viewport.current = null }
    }, [])
    React.useEffect(() => {
      if (view !== null) viewport.current?.apply(view)
    }, [view])
    return h(React.Fragment, null,
      h('div', { className: 'pv-stage', ref: holder, role: 'img', 'aria-label': t('view'), 'data-testid': 'print-viewport' }),
      failed ? h('p', { role: 'alert', className: 'pv-error' }, t('webgl')) : null)
  }

  function StatusPill({ summary, t }) {
    if (summary.status === 'blocked') {
      return h('p', { role: 'status', className: 'pv-pill is-blocked' }, t('needsFix', { count: summary.errors }))
    }
    if (summary.status === 'review') {
      return h('p', { role: 'status', className: 'pv-pill' }, t('needsReview', { count: summary.warnings }))
    }
    return null
  }

  function MeshPane({ useScene, t }) {
    const state = useScene(value => value)
    const scene = state.scene
    if (scene === null || scene.objects.length === 0) {
      return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
        h('div', { className: 'pv-empty' },
          h('p', { className: 'pv-empty-title' }, t('empty')),
          h('p', { className: 'pv-empty-hint' }, t('emptyHint'))))
    }
    if (state.view === null) {
      return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
        h('p', {
          role: scene.failed ? 'alert' : 'status',
          className: scene.failed ? 'pv-message' : 'pv-loading',
        }, scene.failed ? t('previewFailed') : t('loading')))
    }
    return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
      h(Stage, { view: state.view, t }),
      h(StatusPill, { summary: scene.summary, t }),
      scene.failed ? h('p', { role: 'alert', className: 'pv-error' }, t('previewFailed')) : null)
  }

  function MeshDocument({ content, resourceAddress, t }) {
    const mesh = React.useMemo(() => {
      if (content.kind !== 'bytes') return null
      try {
        const positions = parseStl(content.data)
        // A reloaded file is new geometry, so it gets its own datablock rather than
        // reusing the one the viewport already holds.
        const datablockId = `file:${crypto.randomUUID()}`
        return {
          volume: null,
          objects: [{
            id: datablockId, datablockId, positions, blocked: false,
            matrix: placeMesh(positions).matrix,
          }],
        }
      } catch {
        // An unreadable file is a preview failure, not a broken tab.
        return null
      }
    }, [content])
    return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
      mesh === null
        ? h('p', { role: 'alert', className: 'pv-message' }, t('failed'))
        : h(Stage, { key: `${resourceAddress}:${mesh.objects[0].datablockId}`, view: mesh, t }))
  }

  function Title({ useTabInfo }) {
    const { tab } = useTabInfo()
    return h(React.Fragment, null, h(PluginArtworkDefault, { size: 16 }), tab.title)
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    priority: 'builtin',
    title: () => t('title'),
    guide: [{ id: 'open', order: 45, title: () => t('title'), description: () => t('summary'), icon: PluginArtworkDefault }],
  }), 'print viewer: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: sessionId => ({ hooks: { scene: { subscribe, getSnapshot: () => read(sessionId) } } }),
  }, MeshPane)), 'print viewer: tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID,
  }, Title)), 'print viewer: tab title')
  ctx.effect(() => ctx.documentPreviews.register({
    id: ID, extensions: ['stl'], binaryExtensions: ['stl'], priority: 'extension',
    title: () => t('title'), loading: 'bytes-complete', wrap: false,
  }), 'print viewer: STL metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: ID, locale: NS,
  }, MeshDocument)), 'print viewer: STL body')
}
