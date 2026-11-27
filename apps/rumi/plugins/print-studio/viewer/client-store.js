/** Scene polling store, geometry cache, and background validation/evidence/cursor RPC handlers for the viewer client. */
import { renderControlEvidence } from './analog/evidence-renderer.js'
import { parseStl } from './stl.js'

const POLL_MS = 2000
const MAX_GEOMETRY = 32
const EMPTY = Object.freeze({ scene: null, view: null })

function sceneUnchanged(previous, next) {
  return previous != null
    && previous.revision === next.revision
    && JSON.stringify(previous.design) === JSON.stringify(next.design)
    && JSON.stringify(previous.validation) === JSON.stringify(next.validation)
    && JSON.stringify(previous.models) === JSON.stringify(next.models)
    && JSON.stringify(previous.workingModels) === JSON.stringify(next.workingModels)
    && previous.agentRunning === next.agentRunning
    && (previous.agentActivity ?? null) === (next.agentActivity ?? null)
    && previous.selectedModel === next.selectedModel
    && previous.catalogFailed === next.catalogFailed
    && !previous.failed
}

/**
 * Create the browser-side scene store that polls `/api/print-studio/viewer/state`,
 * caches STL datablock geometry, and fulfills host validation/evidence/cursor requests.
 */
export function createViewerClientStore({ ctx, route, kind, maxScenes, artifacts }) {
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
    while (snapshots.size > maxScenes) snapshots.delete(snapshots.keys().next().value)
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
      const response = await fetch(`${route}/state?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('preview state unavailable')
      return response.json()
    }

    const readPositions = async (sessionId, datablockId) => {
      const response = await fetch(
        `${route}/model?sessionId=${encodeURIComponent(sessionId)}&datablockId=${encodeURIComponent(datablockId)}`,
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

    const handleRequests = async (sessionId, response) => {
      for (const job of response.validationRequests ?? []) {
        let bytes, contentType = 'application/octet-stream'
        try { bytes = (await artifacts.resolve(job)).bytes }
        catch (error) { bytes = String(error.message ?? error); contentType = 'text/plain' }
        if (stopped()) return false
        const submitted = await fetch(`${route}/validation?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(job.id)}`, {
          method: 'POST', headers: { 'content-type': contentType }, body: bytes, signal: controller.signal,
        })
        if (!submitted.ok && submitted.status !== 409) throw new Error('Validation geometry delivery failed')
      }
      if (response.controlValidationRequest) {
        const job = response.controlValidationRequest
        let result
        try {
          const artifact = await artifacts.resolve({ ...job.identity, format: 'usd' })
          result = await renderControlEvidence(artifact.bytes, job, controller.signal)
        } catch (error) { result = { status: 'failed', message: String(error.message ?? error).slice(0, 2000) } }
        if (stopped()) return false
        const submitted = await fetch(`${route}/control-evidence?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ id: job.id, result }),
        })
        if (!submitted.ok && submitted.status !== 409) throw new Error('Control evidence delivery failed')
      }
      if (response.cursorRequest) {
        let snapshot
        try { snapshot = captures.get(sessionId)?.() ?? { status: 'viewer_unavailable', reason: 'viewer_not_open' } }
        catch (_error) { snapshot = { status: 'capture_failed' } }
        try {
          const posted = await fetch(`${route}/cursor?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
            body: JSON.stringify({ requestId: response.cursorRequest.id, snapshot }),
          })
          if (!posted.ok && posted.status !== 409) console.warn('Cursor snapshot delivery failed', posted.status)
        } catch (error) { if (!stopped()) console.warn('Cursor snapshot delivery failed', error) }
        if (stopped()) return false
      }
      return true
    }

    const tick = async (sessionId) => {
      if (sessionId === undefined) return
      const current = snapshots.get(sessionId)
      const response = await readScene(sessionId)
      const scene = response.scene ?? null
      if (stopped()) return
      if (!(await handleRequests(sessionId, response))) return
      if (scene === null) { publish(sessionId, EMPTY); return }
      const complete = scene.objects.every(object => geometry.has(object.datablockId))
      if (sceneUnchanged(current?.scene, scene) && complete && current.view !== null) return
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
      ctx.sidebarRight.openTabIn(sessionId, kind)
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
        if (!stopped() && pending === task && !document.hidden && ctx.sidebarRight.mounted.getSnapshot() !== undefined) {
          timer = setTimeout(run, POLL_MS)
        }
      })
      pending = task
      return task
    }

    refreshScene = run
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => { void run() })
    const visible = () => { void run() }
    document.addEventListener('visibilitychange', visible)
    run()
    return async () => {
      controller.abort()
      unsubscribe()
      document.removeEventListener('visibilitychange', visible)
      clearTimeout(timer)
      await pending
      captures.clear()
      snapshots.clear()
      opened.clear()
      geometry.clear()
      listeners.clear()
    }
  }, 'print viewer: scene polling')

  return {
    captures,
    read,
    subscribe,
    refresh: sessionId => refreshScene?.(sessionId),
  }
}
