/** Turn-end validation owns immutable sources, renderer requests, and Blender subprocesses. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createSource } from './source.js'
import { discoverModels } from './catalog.js'
import { normalizePlacement } from './transform.js'
import { parseStl, STL_LIMITS } from './stl.js'
import { runValidation } from '../blender/validation-runner.js'

/**
 * Automatically check changed project models on turn/end; no model tool call is required.
 * JavaScript snapshots wait for a renderer without changing its selection. Results remain
 * scoped to their source hash and placement; starting another turn invalidates presentation.
 * @param {object} ctx Plugin context with session events and source routes.
 * @param {object} config Resolved Blender configuration and thresholds.
 * @param {object} options Viewer geometry/placement lookup, notification, and optional runner.
 * @returns {object} State/read, renderer submission, and quiescent disposal operations.
 */
export function createValidation(ctx, config, { view, notify, createUserMessage, run = runValidation }) {
  const sessions = new Map(), tasks = new Set()
  let closed = false, queue = Promise.resolve()
  function sessionFor(id) {
    let value = sessions.get(id)
    if (!value) { value = { generation: 0, models: new Map(), error: null, attempts: 0, sent: new Set(), repairAllowed: false, scanning: false }; sessions.set(id, value) }
    return value
  }
  function repair(id) {
    const session = sessions.get(id)
    const agent = ctx.agents?.get(id)
    if (closed || !session?.repairAllowed || session.error || session.scanning || !agent || agent.status !== 'idle'
      || session.attempts >= config.validationRepairAttempts) return
    const items = [...session.models.values()]
    if (items.some(item => ['checking', 'awaiting_viewer', 'changed'].includes(item.status))) return
    const failures = items.filter(item => item.status === 'needs_repair'
      && item.checkedFingerprint === item.fingerprint && !session.sent.has(`${item.path}:${item.fingerprint}`))
    if (!failures.length) return
    const findings = failures.map(item => ({ path: item.path, fingerprint: item.fingerprint, report: item.result }))
    session.attempts++
    for (const item of failures) session.sent.add(`${item.path}:${item.fingerprint}`)
    try {
      agent.followup(createUserMessage({ source: { kind: 'print-validation', form: 'notice', summary: 'Repairing print geometry' }, content: [{ type: 'text', text:
        'Automatic print validation found blocking geometry errors. Repair the affected saved models now, preserving the requested design and moving parts. Inspect the findings and source; do not hide errors by removing requested features. Do not print or send to a printer. A fresh Blender check runs automatically after your turn. Passing geometry checks does not certify joint clearance, assembly, or slicer readiness. If you cannot safely resolve the errors, say so briefly. Findings:\n' + JSON.stringify(findings),
      }] }))
    } catch (error) {
      session.error = `Could not start geometry repair: ${String(error.message ?? error)}`
      notify(id)
    }
  }
  function track(work) {
    tasks.add(work)
    void work.finally(() => tasks.delete(work)).catch(() => {})
    return work
  }
  function fingerprint(state, transform, volume) {
    return createHash('sha256').update(JSON.stringify([state.contentHash, transform, volume, config.validation])).digest('hex')
  }
  function start(id) {
    const session = sessionFor(id)
    session.repairAllowed = false
    session.generation++
    for (const item of session.models.values()) {
      item.controller?.abort()
      item.request = null
      item.status = 'changed'
    }
    notify(id)
  }
  function enqueue(id, session, item, input, generation) {
    const valid = () => !closed && sessions.get(id) === session && session.generation === generation && session.models.get(item.path) === item
    item.status = 'checking'; item.request = null
    item.controller = new AbortController()
    const controller = item.controller
    const work = queue.then(async () => {
      if (!valid() || controller.signal.aborted) return
      try {
        const report = await run(config, input, controller.signal)
        if (!valid() || controller.signal.aborted) return
        if (item.source) {
          await item.source.poll(); await item.source.poll()
          const state = item.source.state()
          if (state.error || fingerprint(state, input.transform, input.volume) !== item.fingerprint) {
            item.status = 'changed'; return
          }
        }
        if (!valid() || controller.signal.aborted) return
        item.result = report; item.checkedFingerprint = item.fingerprint; item.status = report.status; item.error = null
      } catch (error) {
        if (valid() && !controller.signal.aborted) { item.status = 'unavailable'; item.error = String(error.message ?? error) }
      } finally { if (valid()) { notify(id); repair(id) } }
    })
    queue = work.catch(() => {})
    track(work)
    notify(id)
  }
  async function scan(id, cwd, generation) {
    const session = sessionFor(id)
    const valid = () => !closed && sessions.get(id) === session && session.generation === generation
    session.scanning = true
    try {
      const catalog = await discoverModels(cwd)
      if (!valid()) return
      const seen = new Set()
      const current = view(id)
      for (const model of catalog) {
        if (!valid()) return
        seen.add(model.path)
        let item = session.models.get(model.path)
        if (!item) { item = { path: model.path, status: 'changed' }; session.models.set(model.path, item) }
        try {
          if (!item.source) {
            const source = await createSource(ctx, resolve(cwd, model.path), cwd)
            if (!valid()) { await source.dispose(); return }
            item.source = source
          }
          await item.source.poll(); await item.source.poll()
          if (!valid()) return
          const state = item.source.state()
          if (state.error) throw new Error(state.error.message)
          const transform = current.selectedModel === model.path ? current.transform : normalizePlacement()
          const volume = current.volume
          const hash = fingerprint(state, transform, volume)
          item.fingerprint = hash; item.sourceHash = state.contentHash; item.error = null
          if (item.checkedFingerprint === hash) { item.status = item.result.status; continue }
          item.controller?.abort(); item.request = null
          const input = { format: state.format === 'glb' ? 'glb' : 'stl', transform, volume }
          if (state.format === 'glb') enqueue(id, session, item, { ...input, bytes: item.source.snapshotBytes() }, generation)
          else {
            item.status = 'awaiting_viewer'
            item.request = { id: randomUUID(), path: model.path, url: state.url, parameters: state.parameters, fingerprint: hash }
            item.input = input; item.generation = generation
          }
        } catch (error) {
          if (valid()) { item.status = 'unavailable'; item.error = String(error.message ?? error); item.request = null }
        }
      }
      if (!valid()) return
      for (const mesh of current.meshes) {
        seen.add(mesh.path)
        const hash = createHash('sha256').update(mesh.bytes).update(JSON.stringify([mesh.transform, current.volume, config.validation])).digest('hex')
        let item = session.models.get(mesh.path)
        if (!item) { item = { path: mesh.path, status: 'changed' }; session.models.set(mesh.path, item) }
        item.fingerprint = hash
        if (item.checkedFingerprint === hash) item.status = item.result.status
        else enqueue(id, session, item, { ...mesh, format: 'stl', volume: current.volume }, generation)
      }
      for (const [path, item] of session.models) {
        if (seen.has(path)) continue
        item.controller?.abort(); await item.source?.dispose(); session.models.delete(path)
      }
      session.error = null
    } catch (error) {
      if (valid()) session.error = String(error.message ?? error)
    } finally { if (valid()) { session.scanning = false; notify(id); repair(id) } }
  }
  ctx.on('session/event', (session, event) => {
    if (closed) return
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const state = sessionFor(session.id)
      state.attempts = 0; state.sent.clear()
    }
    if (event.type === 'turn/start') start(session.id)
    if (event.type === 'turn/end') {
      const state = sessionFor(session.id)
      state.repairAllowed = event.data?.reason.kind === 'completed'
      const cwd = session.header.cwd
      if (!cwd) return
      track(scan(session.id, cwd, state.generation))
    }
  })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') repair(agent.session.id) })
  ctx.on('session/disposed', session => {
    const value = sessions.get(session.id)
    if (!value) return
    sessions.delete(session.id)
    for (const item of value.models.values()) item.controller?.abort()
    const admitted = [...tasks]
    track((async () => {
      await Promise.allSettled(admitted)
      await Promise.all([...value.models.values()].map(item => item.source?.dispose()))
    })())
  })
  return {
    /** Reports refer to saved geometry; live control previews are not validated. */
    read(id) {
      const session = sessions.get(id)
      const current = view(id)
      return { error: session?.error ?? null, models: [...(session?.models.values() ?? [])].map(item => {
        const selectedChanged = current.selectedModel === item.path && (current.analog
          || fingerprint({ contentHash: current.sourceHash }, current.transform, current.volume) !== item.fingerprint)
        const status = selectedChanged ? 'changed' : item.status
        const matches = item.checkedFingerprint === item.fingerprint && ['passed', 'review', 'needs_repair'].includes(status)
        return { path: item.path, status, fingerprint: item.fingerprint ?? null, sourceHash: item.sourceHash ?? null,
          report: matches ? item.result : null, previousReport: matches ? null : item.result ?? null,
          error: item.error ?? null }
      }) }

    },
    /** Renderer jobs use immutable module URLs and never change viewer selection. */
    requests(id) { return [...(sessions.get(id)?.models.values() ?? [])].flatMap(item => item.request ? [item.request] : []) },
    /** Accept bounded binary STL only for the still-pending request. */
    submit(id, requestId, bytes, error) {
      const session = sessions.get(id)
      const item = [...(session?.models.values() ?? [])].find(item => item.request?.id === requestId)
      if (!item || closed) return false
      if (error !== null) { item.status = 'unavailable'; item.error = error.slice(0, 2000); item.request = null; notify(id); repair(id); return true }
      if (bytes.byteLength > STL_LIMITS.maxBytes) throw new Error('Validation mesh exceeds 20 MiB')
      parseStl(bytes)
      enqueue(id, session, item, { ...item.input, bytes }, item.generation)
      return true
    },
    /** Stop admission, kill children, await scans and jobs, then release snapshots. */
    async dispose() {
      closed = true
      for (const session of sessions.values()) for (const item of session.models.values()) item.controller?.abort()
      await Promise.allSettled([...tasks])
      await Promise.all([...sessions.values()].flatMap(session => [...session.models.values()].map(item => item.source?.dispose())))
      sessions.clear()
    },
  }
}
