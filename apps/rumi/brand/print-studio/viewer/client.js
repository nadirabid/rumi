/**
 * The mesh preview's browser half: registrations, the scene subscription, and
 * the pane that hands the scene to the viewport.
 *
 * It loads datablock bytes once per mesh, then follows scene changes as
 * placement only. Nothing here imports three: the viewport is a separate
 * module, and this half never measures or transforms geometry.
 */
import { createAnalogPanel } from './analog/controls.js'
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
  const AnalogPanel = createAnalogPanel(React)
  const { PluginArtworkDefault, Button } = primitives
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'print viewer: copy')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'print viewer: styles')

  const captures = new Map()
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

  let refreshScene
  ctx.effect(() => {
    const controller = new AbortController()
    let timer
    let pending
    const stopped = () => controller.signal.aborted
    const readScene = async (sessionId) => {
      const response = await fetch(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('preview state unavailable')
      return response.json()
    }
    const readPositions = async (sessionId, datablockId) => {
      const response = await fetch(
        `${ROUTE}/model?sessionId=${encodeURIComponent(sessionId)}&datablockId=${encodeURIComponent(datablockId)}`,
        { signal: controller.signal },
      )
      if (!response.ok) throw new Error('preview bytes unavailable')
      return parseStl(await response.arrayBuffer())
    }
    const viewOf = (scene, sessionId) => ({
      revision: scene.revision,
      design: scene.design ?? null,
      sessionId,
      volume: scene.volume,
      objects: scene.objects.map(object => ({
        id: object.id,
        datablockId: object.datablockId,
        positions: geometry.get(object.datablockId),
        matrix: object.matrix,
        blocked: object.blocked,
      })),
    })
    const tick = async (sessionId) => {
      if (sessionId === undefined) return
      const current = snapshots.get(sessionId)
      const response = await readScene(sessionId)
      const scene = response.scene ?? null
      if (stopped()) return
      if (response.cursorRequest) {
        let snapshot
        try { snapshot = captures.get(sessionId)?.(response.cursorRequest) ?? { status: 'viewer_unavailable' } }
        catch (_error) { snapshot = { status: 'capture_failed' } }
        try {
          const posted = await fetch(`${ROUTE}/cursor?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ requestId: response.cursorRequest.id, snapshot }),
          })
          if (!posted.ok && posted.status !== 409) console.warn('Cursor snapshot delivery failed', posted.status)
        } catch (error) { if (!stopped()) console.warn('Cursor snapshot delivery failed', error) }
        if (stopped()) return
      }
      if (scene === null) { publish(sessionId, EMPTY); return }
      const unchanged = current?.scene != null && current.scene.revision === scene.revision
        && JSON.stringify(current.scene.design) === JSON.stringify(scene.design)
        && JSON.stringify(current.scene.models) === JSON.stringify(scene.models)
        && current.scene.selectedModel === scene.selectedModel
        && current.scene.catalogFailed === scene.catalogFailed
        && !current.scene.failed
      const complete = scene.objects.every(object => geometry.has(object.datablockId))
      if (unchanged && complete && current.view !== null) return
      // Publish the scene before its geometry so a failed fetch is reportable.
      if (!complete) publish(sessionId, { scene, view: current?.view ?? null })
      for (const object of scene.objects) {
        if (geometry.has(object.datablockId)) continue
        if (geometry.size >= MAX_GEOMETRY) geometry.clear()
        geometry.set(object.datablockId, await readPositions(sessionId, object.datablockId))
      }
      if (stopped()) return
      publish(sessionId, { scene, view: viewOf(scene, sessionId) })
      const opening = scene.design?.url ?? scene.revision
      if ((scene.objects.length === 0 && !scene.design) || opened.get(sessionId) === opening) return
      opened.set(sessionId, opening)
      ctx.sidebarRight.openTabIn(sessionId, KIND)
    }
    const run = (sessionId = ctx.sidebarRight.mounted.getSnapshot()) => {
      clearTimeout(timer)
      // Serialize refreshes so an older poll cannot overwrite a selected model.
      const task = Promise.resolve(pending).then(() => {
        if (!stopped()) return tick(sessionId)
      }).catch(() => {
        if (stopped()) return
        const current = sessionId === undefined ? undefined : snapshots.get(sessionId)
        if (current?.scene) publish(sessionId, { scene: { ...current.scene, failed: true }, view: current.view })
      }).finally(() => {
        if (!stopped() && pending === task) timer = setTimeout(run, POLL_MS)
      })
      pending = task
      return task
    }
    refreshScene = run
    run()
    return async () => {
      controller.abort()
      clearTimeout(timer)
      await pending
      captures.clear()
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
    const designReady = React.useRef(Promise.resolve(null))
    const [failed, setFailed] = React.useState(false)
    const [buildError, setBuildError] = React.useState(null)
    const [cursorMode, setCursorMode] = React.useState('patch')
    const analogValues = React.useRef(null), analogId = React.useRef(null), analogSequence = React.useRef(0), analogDelivery = React.useRef(Promise.resolve())
    const analogAbort = React.useRef(null)
    React.useEffect(() => {
      try {
        viewport.current = createViewport(holder.current, () => setFailed(true), setCursorMode)
        setFailed(false)
      } catch {
        // Without WebGL the pane still displays the failure.
        setFailed(true)
      }
      return () => { viewport.current?.dispose(); viewport.current = null }
    }, [])
    React.useEffect(() => {
      const sessionId = view?.sessionId
      if (!sessionId) return
      const capture = request => viewport.current?.captureCursor(request) ?? { status: 'viewer_unavailable' }
      captures.set(sessionId, capture)
      const controller = new AbortController()
      let timer
      const pump = async (after = 0) => {
        try {
          const response = await fetch(`${ROUTE}/events?sessionId=${encodeURIComponent(sessionId)}&after=${after}`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) throw new Error('Viewer events unavailable')
          const event = await response.json()
          if (controller.signal.aborted || event.closed) return
          if (Number.isSafeInteger(event.version) && event.version !== after) {
            await refreshScene(sessionId)
            if (!controller.signal.aborted) void pump(event.version)
          } else if (!controller.signal.aborted) timer = setTimeout(() => { void pump(after) }, 1000)
        } catch (error) {
          if (!controller.signal.aborted) timer = setTimeout(() => { void pump(after) }, 1000)
        }
      }
      void pump()
      return () => {
        controller.abort()
        clearTimeout(timer)
        if (captures.get(sessionId) === capture) captures.delete(sessionId)
      }
    }, [view?.sessionId])
    React.useEffect(() => {
      if (view !== null) viewport.current?.apply(view)
    }, [view])
    React.useEffect(() => {
      if (!viewport.current?.applyDesign) return
      let active = true
      const controller = new AbortController()
      const receivedAt = performance.now()
      const diagnostics = () => ({ hidden: document.hidden, receivedAt, elapsedMs: performance.now() - receivedAt, width: holder.current?.clientWidth ?? 0, height: holder.current?.clientHeight ?? 0 })
      const trace = (phase) => {
        if (!view?.design?.highlight?.id) return
        void fetch(`${ROUTE}/trace?sessionId=${encodeURIComponent(view.sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ highlightId: view.design.highlight.id, phase, ...diagnostics() }),
        }).then(response => { if (!response.ok) throw new Error(`Trace status ${response.status}`) })
          .catch(error => console.warn('Highlight diagnostics delivery failed', error))
      }
      const feedback = async (value) => {
        if (!active || !view?.design) return
        trace('feedback_started')
        const response = await fetch(`${ROUTE}/feedback?sessionId=${encodeURIComponent(view.sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ revision: view.design.revision, url: view.design.url, transform: view.design.transform, diagnostics: diagnostics(), ...value }),
        })
        if (!response.ok) { trace('feedback_failed'); throw new Error(`Build feedback unavailable (${response.status})`) }
        trace('feedback_delivered')
      }
      trace('apply_started')
      designReady.current = viewport.current.applyDesign(view?.design ?? null, view?.volume ?? null)
      const reportRendered = async () => {
        await designReady.current
        if (!active) return
        const report = await viewport.current.applyDesign(view?.design ?? null, view?.volume ?? null)
        if (!active || !report) return
        const highlightId = viewport.current?.renderedHighlight?.() ?? null
        await feedback({ report, highlightId, requestedHighlightId: view.design.highlight?.id ?? null, highlightStatus: document.hidden ? 'viewer_hidden' : highlightId ? 'rendered' : 'not_ready' })
      }
      const visible = () => {
        if (!document.hidden) void reportRendered().catch(() => { if (active) setBuildError('feedbackFailed') })
      }
      document.addEventListener('visibilitychange', visible)
      designReady.current.then(async (report) => {
        if (!active || !report) return
        setBuildError(null)
        trace('apply_finished')
        const highlightId = viewport.current?.renderedHighlight?.() ?? null
        await feedback({ report, highlightId, requestedHighlightId: view.design.highlight?.id ?? null, highlightStatus: document.hidden ? 'viewer_hidden' : highlightId ? 'rendered' : 'not_ready' })
      }).catch(async (error) => {
        if (!active) return
        trace('apply_or_feedback_failed')
        setBuildError('buildFailed')
        try { await feedback({ error: error instanceof Error ? error.message : String(error), requestedHighlightId: view?.design?.highlight?.id ?? null, highlightStatus: 'render_failed' }) }
        catch (_feedbackError) { if (active) setBuildError('feedbackFailed') }
      })
      return () => { trace('effect_disposed'); active = false; controller.abort(); document.removeEventListener('visibilitychange', visible) }
    }, [
      view?.design?.highlight?.id, view?.design?.url, JSON.stringify(view?.design?.transform), view?.design?.camera?.id,
      view?.sessionId, JSON.stringify(view?.volume),
    ])
    function sendShape(status, values) {
      const spec = view?.design?.analog
      if (!spec) return Promise.resolve()
      const body = { id: spec.id, url: view.design.url, status, values, sequence: ++analogSequence.current, metrics: viewport.current?.shapeMetrics?.() }
      const signal = analogAbort.current?.signal
      const post = async () => {
        if (signal?.aborted) return
        const response = await fetch(`${ROUTE}/shape-feedback?sessionId=${encodeURIComponent(view.sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
        })
        if (!response.ok) throw new Error('Shape control delivery failed')
      }
      const delivery = analogDelivery.current.then(post)
      analogDelivery.current = delivery.catch(() => { if (!signal?.aborted) setBuildError('feedbackFailed') })
      return delivery
    }
    React.useEffect(() => {
      let active = true
      const spec = view?.design?.analog
      if (analogId.current !== spec?.id) {
        analogAbort.current?.abort(); analogAbort.current = new AbortController()
        analogId.current = spec?.id; analogValues.current = spec?.values; analogSequence.current = spec?.editRevision ?? 0
        analogDelivery.current = Promise.resolve()
      }
      void designReady.current.then(() => {
        if (!active || !viewport.current) return
        const values = analogValues.current ?? spec?.values
        const id = viewport.current.applyShape?.(spec ? { ...spec, values } : null)
        if (id && !spec.frozen) return sendShape(spec.freezeRequested ? 'frozen' : 'rendered', values)
      }).catch(() => { if (active) setBuildError('buildFailed') })
      return () => { active = false }
    }, [view?.design?.analog?.id, view?.design?.analog?.freezeRequested, view?.design?.analog?.frozen, view?.design?.url])
    React.useEffect(() => () => analogAbort.current?.abort(), [])
    React.useEffect(() => {
      if (!view?.sessionId) return
      let active = true
      const controller = new AbortController()
      // Debounce changing scenes; a stationary preview never captures on polling or orbit.
      const timer = setTimeout(async () => {
        try {
          if (view.design) {
            const report = await designReady.current
            if (!report || !active) return
          }
          const image = viewport.current?.thumbnail()
          if (!image || !active) return
          const bytes = Uint8Array.from(atob(image.split(',')[1]), character => character.charCodeAt(0))
          const response = await fetch(`/api/rumi-projects/thumbnail?sessionId=${encodeURIComponent(view.sessionId)}`, {
            method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes, signal: controller.signal,
          })
          if (!response.ok && response.status !== 404) throw new Error(`Thumbnail save failed: ${response.status}`)
        } catch (error) {
          if (active) console.warn('Project thumbnail unavailable', error)
        }
      }, 750)
      return () => { active = false; clearTimeout(timer); controller.abort() }
    }, [view])
    return h(React.Fragment, null,
      !view?.design?.analog && h('div', { className: 'pv-cursor-controls', role: 'group', 'aria-label': t('cursorHighlighting') },
        ['patch', 'surface', 'part', 'edge'].map(mode => h(Button, {
          key: mode, variant: 'ghost', size: 'sm', 'aria-pressed': cursorMode === mode,
          onClick: () => { setCursorMode(mode); viewport.current?.setCursorMode(mode) },
        }, t(`cursor_${mode}`)))),
      view?.design?.analog ? h(AnalogPanel, { key: view.design.analog.id, spec: view.design.analog, t, onChange: values => { analogValues.current = values; viewport.current?.updateShape(values) }, onRelease: values => { void sendShape('adjusted', values).catch(_error => { /* sendShape reports delivery failure in the viewer. */ }) } }) : null,
      h('div', { className: 'pv-stage', ref: holder, role: 'img', 'aria-label': t('view'), 'data-testid': 'print-viewport' }),
      buildError && !failed && view?.design?.error?.kind !== 'source'
        ? h('p', { role: 'alert', className: view?.design?.analog ? 'pv-error av-error' : 'pv-error' }, t(buildError)) : null)
  }

  function MeshPane({ useScene, t, selectModel }) {
    const state = useScene(value => value)
    const scene = state.scene
    const [busy, setBusy] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const request = React.useRef(null)
    React.useEffect(() => () => request.current?.abort(), [])
    async function select(path) {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setBusy(true)
      setFailed(false)
      try { await selectModel(path, controller.signal) }
      catch (_error) { if (!controller.signal.aborted) setFailed(true) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
      scene?.models?.length ? h('div', { className: 'pv-models', role: 'group', 'aria-label': t('models') },
        scene.models.map(model => h(Button, {
          key: model.path, variant: 'ghost', size: 'sm', disabled: busy,
          className: 'pv-model-button', title: model.name,
          'aria-pressed': scene.selectedModel === model.path,
          onClick: () => { void select(model.path) },
        }, model.name))) : null,
      failed || scene?.catalogFailed ? h('p', { className: 'pv-catalog-error', role: 'alert' },
        t(failed ? 'selectionFailed' : 'catalogFailed')) : null,
      h('div', { className: 'pv-content' }, h(MeshContent, { state, t })))
  }

  function MeshContent({ state, t }) {
    const scene = state.scene
    if (scene === null || (scene.objects.length === 0 && !scene.design)) {
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
      h(Stage, { key: state.view.sessionId, view: state.view, t }),
      scene.design?.error?.kind === 'source' ? h('p', { role: 'alert', className: 'pv-error' }, t('sourceFailed')) : null,
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
    inject: sessionId => ({
      hooks: { scene: { subscribe, getSnapshot: () => read(sessionId) } },
      selectModel: async (path, signal) => {
        const response = await fetch(`${ROUTE}/select?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }), signal,
        })
        if (!response.ok) throw new Error('Model selection failed')
        if (!signal.aborted) await refreshScene(sessionId)
      },
    }),
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
