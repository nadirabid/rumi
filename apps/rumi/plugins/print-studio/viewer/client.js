/**
 * The mesh preview's browser half: registrations, viewport lifecycle, and panes.
 *
 * Scene polling and host RPCs live in `./client-store.js`; status derivation
 * lives in `./client-status.js`.
 */
import { createLayoutAutosave } from './print-layout/autosave.js'
import { printLayoutIdentity } from './print-layout/state.js'
import { createPrintLayoutPanel } from './print-layout/panel.js'
import { createModelSelector } from './model-selector.js'
import { createAnalogPanel } from './analog/controls.js'
import { createMovementControls } from './movement-controls.js'
import { parseStl } from './stl.js'
import { createModelArtifacts } from './generation/artifacts.js'
import { createViewport } from './viewport/index.js'
import { placeMesh } from './transform.js'
import { en, zh } from './locales.js'
import { createViewerClientStore } from './client-store.js'
import { ACTIVITY_LABELS, activityFor, printValidationLabel, validationLabel } from './client-status.js'
import stylesheet from './viewer.module.css'

const NS = 'rumi.printViewer'
const ID = '@rumi/print-studio/viewer'
const KIND = 'print-studio'
const ROUTE = '/api/print-studio/viewer'
const MAX_SCENES = 8
const LAYOUT_ERRORS = new Set(['layoutSeparateRequired', 'layoutChanged', 'layoutOutside', 'layoutSlicerMissing', 'layoutOpenFailed'])
const layoutSaveKey = view => JSON.stringify([view?.sessionId, view?.design?.path, view?.design?.contentHash, view?.design?.transform, view?.volume])

/**
 * Register the viewer into an already-mounted client plugin.
 * @param {object} ctx - Client plugin context with locale, slots, sidebar services, and document previews.
 * @param {object} React - The shell's React instance.
 * @param {object} primitives - Shared primitives from `@deepseek-ai/dsh-client-ui-primitives`.
 * @returns {void}
 */
export function installViewer(ctx, React, primitives) {
  const autosave = createLayoutAutosave(async request => {
    const response = await fetch(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body })
    if (!response.ok) throw new Error('Layout autosave failed')
  }, MAX_SCENES)
  ctx.effect(() => {
    const preventUnsavedExit = event => { if (autosave.hasUnsaved()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', preventUnsavedExit)
    return async () => { await autosave.dispose(); window.removeEventListener('beforeunload', preventUnsavedExit) }
  }, 'print viewer: layout autosave')

  const artifacts = createModelArtifacts()
  const viewportDisposals = new Set(), liveViewports = new Set()
  ctx.effect(() => async () => {
    await Promise.allSettled([...viewportDisposals, ...[...liveViewports].map(viewport => viewport.dispose())])
    liveViewports.clear()
    await artifacts.dispose()
  }, 'print viewer: generated artifacts')

  const h = React.createElement
  const AnalogPanel = createAnalogPanel(React)
  const MovementControls = createMovementControls(React, AnalogPanel)
  const { PluginArtworkDefault, Button } = primitives
  const ModelSelector = createModelSelector(React, Button)
  const PrintLayoutPanel = createPrintLayoutPanel(React, primitives)
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'print viewer: copy')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = stylesheet
    document.head.append(style)
    return () => style.remove()
  }, 'print viewer: styles')

  const store = createViewerClientStore({ ctx, route: ROUTE, kind: KIND, maxScenes: MAX_SCENES, artifacts })

  /** The canvas and its three.js adapter; mounted only while the scene has objects. */
  function Stage({ view, activity = 'idle', t }) {
    const holder = React.useRef(null)
    const regionMarker = React.useRef(null)
    const projectedRegion = React.useRef(null)
    const [label, setLabel] = React.useState(null)
    const viewport = React.useRef(null)
    const designReady = React.useRef(Promise.resolve(null))
    const viewportError = React.useRef(null)
    const [failed, setFailed] = React.useState(false)
    const [buildError, setBuildError] = React.useState(null)
    const working = activity !== 'idle'
    const [cursorPreference, setCursorPreference] = React.useState(null)
    const [motion, setMotion] = React.useState(null)
    const [printState, setPrintState] = React.useState(null)
    const [printBusy, setPrintBusy] = React.useState(false)
    const [printMessage, setPrintMessage] = React.useState(null)

    const highlight = view?.design?.highlight
    const region = label ?? (highlight?.regionName ? { id: highlight.id, name: highlight.regionName } : null)
    const hasNamedRegions = Boolean(view?.design?.regionMap)
    const canUseNamedRegions = hasNamedRegions && !view.design.analog
    const defaultCursor = canUseNamedRegions && view.design.regionStatus !== 'invalid' ? 'named' : 'patch'
    const cursorMode = cursorPreference === 'named' && !canUseNamedRegions ? defaultCursor : cursorPreference ?? defaultCursor

    function drawRegionLabel(element, position) {
      if (!element) return
      element.hidden = position?.id !== element.dataset.regionId
      if (element.hidden) return
      element.style.setProperty('--pv-region-x', `${position.x.toFixed(2)}%`)
      element.style.setProperty('--pv-region-y', `${position.y.toFixed(2)}%`)
    }
    const bindRegionMarker = React.useCallback(element => {
      regionMarker.current = element
      drawRegionLabel(element, projectedRegion.current)
    }, [])
    function positionRegion(position) {
      const previous = projectedRegion.current
      projectedRegion.current = position
      if (position?.id !== previous?.id || position?.name !== previous?.name) {
        setLabel(position ? { id: position.id, name: position.name } : null)
      }
      drawRegionLabel(regionMarker.current, position)
    }

    const printOptions = React.useRef(null), printRequest = React.useRef(null)
    const saveKey = layoutSaveKey(view)
    const saveStatus = React.useSyncExternalStore(autosave.subscribe, () => autosave.status(saveKey))
    const printTarget = React.useRef(view)
    printTarget.current = view

    function receivePrintState(state) {
      setPrintState(state)
      const target = printTarget.current
      if (!state.active || !target?.design || state.layout.identity !== printLayoutIdentity(target.design, state.layout.volume)) return
      const query = `sessionId=${encodeURIComponent(target.sessionId)}&sourceHash=${encodeURIComponent(target.design.contentHash)}`
      autosave.update(layoutSaveKey(target), {
        sessionId: target.sessionId,
        url: `${ROUTE}/layout?${query}`,
        body: JSON.stringify(state.layout),
      })
    }

    React.useEffect(() => {
      setPrintMessage(null); setPrintBusy(false)
      return () => printRequest.current?.abort()
    }, [view?.design?.url])

    async function printAction(action, value) {
      const owner = viewport.current
      if (!owner || (working && action !== 'close' && action !== 'retry-save')) return
      setPrintMessage(null)
      let controller = null
      try {
        if (action === 'retry-save') { autosave.retry(saveKey); return }
        if (action === 'close') { if (await autosave.flush(saveKey) && layoutSaveKey(printTarget.current) === saveKey && viewport.current === owner) owner.closePrintLayout(); return }
        if (action === 'plate') { owner.selectPrintPlate(value); return }
        if (action === 'edit') { owner.editPrintPart(value); return }
        if (action === 'undo') { owner.undoPrintLayout(); return }
        if (action === 'arrange') { owner.rearrangePrintParts(printOptions.current); return }
        printRequest.current?.abort()
        controller = new AbortController(); printRequest.current = controller
        setPrintBusy(true)
        const query = `sessionId=${encodeURIComponent(view.sessionId)}&sourceHash=${encodeURIComponent(view.design.contentHash)}`
        if (action === 'open' || action === 'fresh') {
          await autosave.flush(saveKey)
          await designReady.current
          const response = await fetch(`${ROUTE}/layout?${query}&fresh=${action === 'fresh' ? '1' : '0'}`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) { const failure = await response.json(); throw new Error(failure.error === 'layoutSeparateRequired' ? failure.error : 'layoutFailed') }
          const saved = await response.json()
          if (controller.signal.aborted) return
          printOptions.current = saved.options
          owner.openPrintLayout(action === 'fresh' ? null : owner.printLayoutState().layout ?? autosave.draft(saveKey) ?? saved.layout, saved.options)
          if (saved.stale) setPrintMessage('layoutChanged')
          else if (saved.validationStatus === 'needs_repair') setPrintMessage('validationRepair')
          else if (saved.validationStatus === 'unavailable') setPrintMessage('validationUnavailable')
          else if (saved.validationStatus === 'review') setPrintMessage('validationReview')
          else if (saved.validationStatus === 'unverified') setPrintMessage('layoutChecksMissing')
          else if (saved.validationStatus === 'passed') setPrintMessage('validationChecksPassed')
          else if (saved.validationStatus === 'accepted') setPrintMessage('layoutModelChecked')
        } else {
          if (!await autosave.flush(saveKey) || controller.signal.aborted || layoutSaveKey(printTarget.current) !== saveKey) return
          const response = await fetch(`${ROUTE}/open-plate?${query}`, { method: 'POST', signal: controller.signal, body: owner.exportPrintPlate() })
          const result = await response.json()
          if (!controller.signal.aborted) setPrintMessage(response.ok ? 'layoutOpened' : (LAYOUT_ERRORS.has(result.error) ? result.error : 'layoutFailed'))
        }
      } catch (error) {
        if (!controller || (!controller.signal.aborted && printRequest.current === controller)) {
          setPrintMessage(error.message === 'layoutSeparateRequired' ? error.message : 'layoutFailed')
        }
      } finally {
        if (controller && !controller.signal.aborted && printRequest.current === controller) setPrintBusy(false)
      }
    }

    const analogRendered = React.useRef(null), analogInput = React.useRef(0)
    const analogValues = React.useRef(null), analogId = React.useRef(null), analogSequence = React.useRef(0), analogDelivery = React.useRef(Promise.resolve())
    const analogAbort = React.useRef(null)

    React.useEffect(() => {
      viewport.current?.setActivity(activity)
      if (working) { printRequest.current?.abort(); setPrintBusy(false) }
    }, [activity])

    // OrbitControls must disconnect from its original root before the canvas detaches.
    React.useLayoutEffect(() => {
      try {
        viewport.current = createViewport(holder.current, () => { viewportError.current = '3D viewer rendering failed'; setFailed(true) }, undefined, artifacts, receivePrintState, positionRegion)
        viewport.current.setActivity(activity)
        liveViewports.add(viewport.current)
        setFailed(false)
      } catch (error) {
        viewportError.current = error instanceof Error ? error.message : String(error)
        setFailed(true)
      }
      return () => {
        liveViewports.delete(viewport.current)
        const disposal = Promise.resolve(viewport.current?.dispose())
        viewportDisposals.add(disposal)
        void disposal.finally(() => viewportDisposals.delete(disposal)).catch(error => console.warn('Viewer disposal failed', error))
        viewport.current = null
      }
    }, [])

    React.useLayoutEffect(() => { viewport.current?.setCursorMode(cursorMode) }, [cursorMode])

    React.useEffect(() => {
      const sessionId = view?.sessionId
      if (!sessionId) return
      const capture = () => viewport.current?.captureCursor() ?? { status: 'viewer_unavailable', reason: 'viewer_not_open' }
      store.captures.set(sessionId, capture)
      const controller = new AbortController()
      let timer
      const pump = async (after = 0) => {
        try {
          const response = await fetch(`${ROUTE}/events?sessionId=${encodeURIComponent(sessionId)}&after=${after}`, { signal: controller.signal, cache: 'no-store' })
          if (!response.ok) throw new Error('Viewer events unavailable')
          const event = await response.json()
          if (controller.signal.aborted || event.closed) return
          if (Number.isSafeInteger(event.version) && event.version !== after) {
            await store.refresh(sessionId)
            if (!controller.signal.aborted) void pump(event.version)
          } else if (!controller.signal.aborted) timer = setTimeout(() => { void pump(after) }, 1000)
        } catch {
          if (!controller.signal.aborted) timer = setTimeout(() => { void pump(after) }, 1000)
        }
      }
      void pump()
      return () => {
        controller.abort()
        clearTimeout(timer)
        if (store.captures.get(sessionId) === capture) store.captures.delete(sessionId)
      }
    }, [view?.sessionId])

    React.useEffect(() => {
      let active = true
      if (view !== null) Promise.resolve(viewport.current?.apply(view)).catch(() => { if (active) setBuildError('buildFailed') })
      return () => { active = false }
    }, [view])

    React.useEffect(() => {
      if (!view?.design) { viewport.current?.applyDesign?.(null, view?.volume ?? null); return }
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
          body: JSON.stringify({
            revision: view.design.revision, url: view.design.url, renderRequest: view.design.renderRequest,
            transform: view.design.transform, volume: view.volume, diagnostics: diagnostics(),
            ...(value.report ? { regionResolution: viewport.current.regionResolution() } : {}),
            ...value,
          }),
        })
        if (response.status === 409) return
        if (!response.ok) { trace('feedback_failed'); throw new Error(`Build feedback unavailable (${response.status})`) }
        trace('feedback_delivered')
      }
      if (!viewport.current?.applyDesign || failed) {
        void feedback({ loadStatus: 'build_failed', error: viewportError.current ?? '3D viewer unavailable' })
          .catch(() => { if (active) setBuildError('feedbackFailed') })
        return () => { active = false; controller.abort() }
      }
      trace('apply_started')
      let spec = view.design
      designReady.current = (async () => {
        if (spec.highlight?.meshPath) {
          const query = new URLSearchParams({ sessionId: view.sessionId, id: spec.highlight.id })
          const response = await fetch(`${ROUTE}/highlight-mesh?${query}`, { signal: controller.signal })
          if (!response.ok) throw new Error(`Highlight mesh unavailable (${response.status})`)
          const positions = parseStl(await response.arrayBuffer())
          if (!active) return null
          spec = { ...spec, highlight: { ...spec.highlight, positions } }
        }
        return viewport.current.applyDesign(spec, view.volume ?? null)
      })()
      const sendReport = async (report) => {
        const highlightId = viewport.current?.renderedHighlight?.() ?? null
        await feedback({
          report, parameters: viewport.current.modelParameters(), motion: viewport.current.motionControls?.() ?? null,
          loadStatus: document.hidden ? 'viewer_hidden' : 'ready',
          highlightId, requestedHighlightId: view.design.highlight?.id ?? null,
          highlightStatus: document.hidden ? 'viewer_hidden' : highlightId ? 'rendered' : viewport.current?.highlightBlockedBy?.() ?? 'not_ready',
        })
      }
      const visible = () => {
        if (document.hidden) return
        void (async () => {
          await designReady.current
          if (!active) return
          const report = await viewport.current.applyDesign(spec, view.volume ?? null)
          if (active && report) await sendReport(report)
        })().catch(() => { if (active) setBuildError('feedbackFailed') })
      }
      document.addEventListener('visibilitychange', visible)
      designReady.current.then(async (report) => {
        if (!active || !report) return
        setBuildError(null)
        setMotion(viewport.current.motionControls?.() ?? null)
        trace('apply_finished')
        await sendReport(report)
      }).catch(async (error) => {
        if (!active) return
        trace('apply_or_feedback_failed')
        setBuildError('buildFailed')
        try { await feedback({ loadStatus: 'build_failed', error: error instanceof Error ? error.message : String(error), requestedHighlightId: view?.design?.highlight?.id ?? null, highlightStatus: 'render_failed' }) }
        catch { if (active) setBuildError('feedbackFailed') }
      })
      return () => { trace('effect_disposed'); active = false; controller.abort(); document.removeEventListener('visibilitychange', visible) }
    }, [
      view?.design?.highlight?.id, view?.design?.regionMap?.key, view?.design?.url, view?.design?.renderRequest,
      JSON.stringify(view?.design?.transform), view?.design?.camera?.id, view?.sessionId, JSON.stringify(view?.volume), failed,
    ])

    function sendShape(status, values, error) {
      const spec = view?.design?.analog
      if (!spec) return Promise.resolve()
      const body = { id: spec.id, url: view.design.url, status, values, error, sequence: ++analogSequence.current, metrics: viewport.current?.shapeMetrics?.() }
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
        analogInput.current++; analogRendered.current = spec?.values
        analogId.current = spec?.id; analogValues.current = spec?.values; analogSequence.current = spec?.editRevision ?? 0
        analogDelivery.current = Promise.resolve()
      }
      let attempt = 0
      const renderControls = async () => {
        const request = ++attempt
        let status, values
        try {
          await designReady.current
          if (!active || request !== attempt || !viewport.current) return
          values = analogValues.current ?? spec?.values
          if (spec && !spec.frozen && document.hidden) {
            status = 'viewer_hidden'
          } else {
            const id = await viewport.current.applyShape?.(spec ? { ...spec, values } : null)
            if (!active || request !== attempt) return
            if (id && !spec.frozen) { setBuildError(null); status = spec.freezeRequested ? 'frozen' : 'rendered' }
          }
        } catch (error) {
          if (!active) return
          setBuildError('buildFailed')
          try { await sendShape('render_failed', values, error instanceof Error ? error.message : String(error)) }
          catch { if (active) setBuildError('feedbackFailed') }
          return
        }
        if (status) {
          try { await sendShape(status, values) }
          catch { if (active) setBuildError('feedbackFailed') }
        }
      }
      void renderControls()
      const visible = () => { if (!document.hidden) void renderControls() }
      document.addEventListener('visibilitychange', visible)
      return () => { active = false; document.removeEventListener('visibilitychange', visible) }
    }, [view?.design?.analog?.id, view?.design?.analog?.freezeRequested, view?.design?.analog?.frozen, view?.design?.url])

    React.useEffect(() => () => analogAbort.current?.abort(), [])

    React.useEffect(() => {
      if (!view?.sessionId) return
      let active = true
      const controller = new AbortController()
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
      view?.design && h(PrintLayoutPanel, { state: printState, available: !view.design.analog && !failed,
        busy: printBusy, working, message: printMessage, saveStatus, t, action: printAction }),
      motion && h(MovementControls, { key: motion.id, spec: { ...motion, label: t('motionControls') }, t, viewport, stage: holder,
        hidden: printState?.active, disabled: failed || working || Boolean(view?.design?.analog) || view?.design?.url !== motion.id,
        onError: () => setBuildError('buildFailed') }),
      h('div', { className: 'pv-bottom-controls', hidden: printState?.active },
        h('div', { className: 'pv-cursor-controls', role: 'group', 'aria-label': t('cursorHighlighting') },
          ['patch', 'surface', 'part', 'edge', 'named'].map(mode => h(Button, {
            key: mode, variant: 'ghost', size: 'sm', 'aria-pressed': cursorMode === mode,
            disabled: mode === 'named' && !canUseNamedRegions,
            title: mode === 'named' && !canUseNamedRegions ? t(hasNamedRegions ? 'cursorNamedEditing' : 'cursorNamedUnavailable') : undefined,
            onClick: () => setCursorPreference(mode),
          }, t(`cursor_${mode}`))))),
      view?.design?.analog ? h('fieldset', { disabled: working, ...(working ? { inert: '' } : {}), className: 'pv-analog-lock' }, h(AnalogPanel, {
        key: view.design.analog.id, spec: view.design.analog, t,
        onChange: async values => {
          const id = analogId.current, input = ++analogInput.current
          analogValues.current = values
          try {
            const updated = await viewport.current?.updateShape(values)
            if (updated === false || id !== analogId.current || input !== analogInput.current) return false
          } catch {
            if (id === analogId.current && input === analogInput.current) { analogValues.current = analogRendered.current; setBuildError('buildFailed') }
            return false
          }
          analogRendered.current = values; setBuildError(null); return true
        },
        onRelease: values => { void sendShape('adjusted', values).catch(() => {}) },
      })) : null,
      h('div', {
        className: 'pv-stage', ref: holder, role: 'img',
        'aria-label': t(working ? (ACTIVITY_LABELS[activity] ?? 'activityBuilding') : 'view'),
        'aria-busy': working, 'data-activity': activity, 'data-testid': 'print-viewport',
        tabIndex: highlight?.regionName && !printState?.active && !failed ? 0 : -1,
        onFocus: event => { if (event.currentTarget.matches(':focus-visible')) viewport.current?.setRegionFocused(true) },
        onBlur: () => viewport.current?.setRegionFocused(false),
      }),
      region?.name && !failed && view?.design && !view.design.error && h('div', {
        key: region.id, className: 'rumi-region-glass pv-region-marker', ref: bindRegionMarker,
        'data-region-id': region.id, hidden: true,
      }, region.name),
      buildError && !failed && view?.design?.error?.kind !== 'source'
        ? h('p', { role: 'alert', className: view?.design?.analog ? 'pv-error av-error' : 'pv-error' }, t(buildError)) : null)
  }

  function MeshPane({ useScene, t, selectModel }) {
    const state = useScene(value => value)
    const scene = state.scene
    const status = scene?.design ? printValidationLabel(scene) : validationLabel(scene)
    const [busy, setBusy] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    const request = React.useRef(null)
    React.useEffect(() => () => request.current?.abort(), [])
    async function select(path) {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      setBusy(true); setFailed(false)
      try { await selectModel(path, controller.signal) }
      catch { if (!controller.signal.aborted) setFailed(true) }
      finally { if (!controller.signal.aborted) setBusy(false) }
    }
    return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
      h(ModelSelector, { scene, busy: busy || activityFor(scene) !== 'idle', select, t }),
      failed || scene?.catalogFailed ? h('p', { className: 'pv-catalog-error', role: 'alert' }, t(failed ? 'selectionFailed' : 'catalogFailed')) : null,
      status && activityFor(scene) === 'idle' && h('span', { role: 'img', className: 'pv-validation-dot', 'aria-label': t(status), title: t(status) }),
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
        h('p', { role: scene.failed ? 'alert' : 'status', className: scene.failed ? 'pv-message' : 'pv-loading' }, scene.failed ? t('previewFailed') : t('loading')))
    }
    return h('section', { className: 'rumi-print-viewer', 'aria-label': t('title') },
      h(Stage, { key: state.view.sessionId, view: state.view, activity: activityFor(scene), t }),
      scene.design?.error?.kind === 'source' ? h('p', { role: 'alert', className: 'pv-error' }, t('sourceFailed')) : null,
      scene.failed ? h('p', { role: 'alert', className: 'pv-error' }, t('previewFailed')) : null)
  }

  function MeshDocument({ content, resourceAddress, t }) {
    const mesh = React.useMemo(() => {
      if (content.kind !== 'bytes') return null
      try {
        const positions = parseStl(content.data)
        const datablockId = `file:${crypto.randomUUID()}`
        return {
          volume: null,
          objects: [{ id: datablockId, datablockId, positions, blocked: false, matrix: placeMesh(positions).matrix }],
        }
      } catch {
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
    id: ID, kind: KIND, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'open', order: 45, title: () => t('title'), description: () => t('summary'), icon: PluginArtworkDefault }],
  }), 'print viewer: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: sessionId => ({
      hooks: { scene: { subscribe: store.subscribe, getSnapshot: () => store.read(sessionId) } },
      selectModel: async (path, signal) => {
        if (!await autosave.flush(layoutSaveKey(store.read(sessionId).view))) throw new Error('Save the current layout before switching models')
        if (signal.aborted) return
        const response = await fetch(`${ROUTE}/select?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }), signal,
        })
        if (!response.ok) throw new Error('Model selection failed')
        if (!signal.aborted) await store.refresh(sessionId)
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
