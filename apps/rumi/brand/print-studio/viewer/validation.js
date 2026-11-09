/** Turn-end validation owns immutable sources, renderer requests, and Blender subprocesses. */
import { summarizeValidationReport } from './validation-summary.js'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { createSource, createSourcePresentation } from './source.js'
import { discoverModels } from './catalog.js'
import { normalizePlacement } from './transform.js'
import { parseStl, STL_LIMITS } from './stl.js'
import { validateUsd, USD_MAX_BYTES } from './usd.js'
import { runValidation } from '../blender/validation-runner.js'
import { validationState, preserveMovement } from './validation-state.js'

// Persisted acceptance is reusable only under the same validation semantics.
const POLICY_VERSION = 4

/**
 * Automatically check changed project models on turn/end; no model tool call is required.
 * JavaScript snapshots wait for a renderer without changing its selection. Results remain
 * scoped to their source hash and placement; starting another turn invalidates presentation.
 * @param {object} ctx Plugin context with session events and source routes.
 * @param {object} config Resolved Blender and Bullet configuration and thresholds.
 * @param {object} options Viewer geometry/placement lookup, notification, and optional runner.
 * @returns State/read, renderer submission, and quiescent disposal operations.
 */
export function createValidation(ctx, config, { view, notify, createUserMessage, run = runValidation }) {
  const sessions = new Map(), tasks = new Set()
  let closed = false, queue = Promise.resolve()
  function sessionFor(id) {
    let value = sessions.get(id)
    if (!value) { value = { generation: 0, models: new Map(), error: null, attempts: 0, sent: new Set(), repairAllowed: false, scanning: false, opened: false, editing: false }; sessions.set(id, value) }
    return value
  }
  function repair(id) {
    const session = sessions.get(id)
    const agent = ctx.agents?.get(id)
    if (closed || !session?.repairAllowed || session.error || session.scanning || !agent || agent.status !== 'idle'
      || session.attempts >= config.validationRepairAttempts) return
    const items = [...session.models.values()]
    if (items.some(item => ['checking', 'awaiting_viewer', 'changed'].includes(item.status))) return
    const failures = items.filter(item => (item.status === 'needs_repair' || (item.status === 'review' && item.result?.mechanics?.status === 'review'))
      && item.checkedFingerprint === item.fingerprint && !session.sent.has(`${item.path}:${item.fingerprint}`))
    if (!failures.length) return
    const findings = failures.map(item => ({ path: item.path, fingerprint: item.fingerprint, report: summarizeValidationReport(item.result) }))
    session.attempts++
    for (const item of failures) session.sent.add(`${item.path}:${item.fingerprint}`)
    try {
      agent.followup(createUserMessage({ source: { kind: 'print-validation', form: 'notice', summary: 'Repairing print geometry' }, content: [{ type: 'text', text:
        'Automatic print validation found blocking geometry or unverified mechanism findings. Repair the affected saved models now, preserving the requested design and moving parts. Inspect the findings and source; do not hide errors by removing requested features or movement declarations. Do not print or send to a printer. Fresh Blender and whole-assembly Bullet checks run automatically after your turn. These checks do not certify assembly, material strength, or slicer readiness. If you cannot safely resolve the errors, say so briefly. Findings:\n' + JSON.stringify(findings),
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
    return createHash('sha256').update(JSON.stringify([POLICY_VERSION, state.contentHash, transform, volume, config.validation, config.mechanics])).digest('hex')
  }
  function publishable(report) {
    if (!['passed', 'review'].includes(report.status) || report.checks.some(check => check.count && check.severity === 'error')) return false
    if (report.mechanics) return report.mechanics.status === 'passed' && report.mechanics.assemblyVerified === true && report.mechanics.coverage?.complete === true
    return report.status === 'passed' && !report.intent?.assembly
  }
  function displayedSource(id, path, source) {
    const accepted = sessions.get(id)?.models.get(path)?.accepted?.presentation
    if (!accepted) return null
    const current = source?.state(), state = accepted.state()
    if (current && !current.error && current.contentHash === state.contentHash
      && JSON.stringify(current.transform) === JSON.stringify(state.transform)) return source
    return accepted
  }
  function start(id) {
    const session = sessionFor(id)
    session.repairAllowed = false
    session.editing = true
    session.generation++
    for (const item of session.models.values()) {
      item.controller?.abort()
      item.request = null
      item.status = 'changed'
    }
    notify(id)
  }
  function prepare(id, session, item, cwd) {
    if (item.storage) return Promise.resolve()
    if (item.preparing) return item.preparing
    const valid = () => !closed && sessions.get(id) === session && session.models.get(item.path) === item
    item.preparing = (async () => {
      const storage = validationState(config.validationStateDirectory, cwd, item.path)
      const saved = await storage.read()
      if (!valid()) return
      if (saved.accepted && fingerprint({ contentHash: saved.accepted.sourceHash }, saved.accepted.transform, saved.accepted.volume) === saved.accepted.fingerprint) {
        const originalPath = resolve(await realpath(cwd), item.path)
        if (!valid()) return
        const source = await createSource(ctx, saved.accepted.path, saved.accepted.workspace)
        if (!valid()) { await source.dispose(); return }
        if (source.state().contentHash !== saved.accepted.sourceHash) {
          await source.dispose()
          throw new Error('Accepted source bytes do not match their validated revision')
        }
        source.transform(saved.accepted.transform)
        item.accepted = { fingerprint: saved.accepted.fingerprint, presentation: createSourcePresentation({ ...source.state(),
          path: originalPath }), release: source.dispose }
      }
      item.storage = storage
      item.required = saved.required
    })().finally(() => { item.preparing = null })
    return item.preparing
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
        if (item.storage) {
          const durable = await item.storage.read()
          if (!valid() || controller.signal.aborted) return
          const preserved = preserveMovement(durable.required, report.intent)
          report.checks.push(...preserved.checks)
          if (preserved.checks.length) report.status = 'needs_repair'
          if (report.status === 'passed' && report.intent?.assembly && !publishable(report)) {
            report.checks.push({ code: 'assembly_verification_incomplete', severity: 'error', count: 1,
              message: 'Complete whole-assembly verification before publishing this revision.' })
            report.status = 'needs_repair'
          }
          const accepted = publishable(report)
          const state = item.source.state()
          state.transform = input.transform
          let release = accepted ? item.source.retainSnapshot() : null
          try {
            await item.storage.write(preserved.required, accepted ? { fingerprint: item.fingerprint, state, volume: input.volume, source: item.source.snapshot() } : null)
            item.required = preserved.required
            if (!valid() || controller.signal.aborted) return
            if (accepted) {
              const previous = item.accepted
              item.accepted = { fingerprint: item.fingerprint, presentation: createSourcePresentation({ ...state, highlight: null, analog: null }), release }
              release = null
              await previous?.release()
            }
          } finally { await release?.() }
        }
        if (!valid() || controller.signal.aborted) return
        if (!item.storage && publishable(report)) item.accepted = { fingerprint: item.fingerprint, transform: structuredClone(input.transform) }
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
          await prepare(id, session, item, cwd)
          if (!valid()) return
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
          const input = { format: state.format === 'usd' ? 'usd' : 'stl', transform, volume }
          if (state.format === 'usd') enqueue(id, session, item, { ...input, bytes: item.source.snapshotBytes() }, generation)
          else {
            item.status = 'awaiting_viewer'
            item.request = { id: randomUUID(), path: model.path, url: state.url, contentHash: state.contentHash, parameters: state.parameters, fingerprint: hash }
            item.input = input; item.generation = generation
          }
        } catch (error) {
          if (valid()) { item.status = 'unavailable'; item.error = String(error.message ?? error); item.request = null }
        }
      }
      if (!valid()) return
      for (const mesh of current.meshes) {
        seen.add(mesh.path)
        const hash = createHash('sha256').update(mesh.bytes).update(JSON.stringify([POLICY_VERSION, mesh.transform, current.volume, config.validation, config.mechanics])).digest('hex')
        let item = session.models.get(mesh.path)
        if (!item) { item = { path: mesh.path, status: 'changed' }; session.models.set(mesh.path, item) }
        item.fingerprint = hash
        if (item.checkedFingerprint === hash) item.status = item.result.status
        else enqueue(id, session, item, { ...mesh, format: 'stl', volume: current.volume }, generation)
      }
      for (const [path, item] of session.models) {
        if (seen.has(path)) continue
        item.controller?.abort(); await item.accepted?.release?.(); await item.source?.dispose(); session.models.delete(path)
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
      state.editing = false
      state.opened = true
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
      await Promise.all([...value.models.values()].map(async item => { await item.accepted?.release?.(); await item.source?.dispose() }))
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
          error: item.error ?? null, acceptedFingerprint: item.accepted?.fingerprint ?? null, requiredMovement: item.required ?? { movements: [] } }
      }) }

    },
    /** Restore accepted source and check existing models once when an idle project opens. */
    restore(id, cwd, path) {
      if (closed || !path) return Promise.resolve()
      const session = sessionFor(id)
      let item = session.models.get(path)
      if (!item) { item = { path, status: 'changed' }; session.models.set(path, item) }
      return track(prepare(id, session, item, cwd).then(() => {
        if (closed || sessions.get(id) !== session || session.opened || session.editing
          || (ctx.agents?.get(id) && ctx.agents.get(id).status !== 'idle')) return
        session.opened = true
        session.repairAllowed = true
        return scan(id, cwd, session.generation)
      }).catch(error => {
        if (!closed && sessions.get(id) === session && session.models.get(path) === item) {
          item.status = 'unavailable'; item.error = String(error.message ?? error)
        }
      }))
    },
    /** Select a verified revision; pending or rejected edits retain the preceding accepted source. */
    presentation(id, path, source) { return displayedSource(id, path, source)?.state() ?? null },
    /** Route presentation-only operations to the source identity currently displayed. */
    displaySource: displayedSource,
    /** Return the last accepted placement of an immutable imported STL object. */
    meshPlacement(id, path) { return sessions.get(id)?.models.get(path)?.accepted?.transform ?? null },
    /** Renderer jobs use immutable module URLs and never change viewer selection. */
    requests(id) { return [...(sessions.get(id)?.models.values() ?? [])].flatMap(item => item.request ? [item.request] : []) },
    /** Accept bounded STL or named USD only for the still-pending request. */
    submit(id, requestId, bytes, error) {
      const session = sessions.get(id)
      const item = [...(session?.models.values() ?? [])].find(item => item.request?.id === requestId)
      if (!item || closed) return false
      if (error !== null) { item.status = 'unavailable'; item.error = error.slice(0, 2000); item.request = null; notify(id); repair(id); return true }
      const usd = new TextDecoder().decode(bytes.subarray(0, 10)).startsWith('#usda 1.0')
      if (bytes.byteLength > (usd ? USD_MAX_BYTES : STL_LIMITS.maxBytes)) throw new Error('Validation mesh exceeds its format limit')
      if (usd) validateUsd(bytes)
      else parseStl(bytes)
      enqueue(id, session, item, { ...item.input, format: usd ? 'usd' : 'stl', bytes }, item.generation)
      return true
    },
    /** Stop admission, kill children, await scans and jobs, then release snapshots. */
    async dispose() {
      closed = true
      for (const session of sessions.values()) for (const item of session.models.values()) item.controller?.abort()
      await Promise.allSettled([...tasks])
      await Promise.all([...sessions.values()].flatMap(session => [...session.models.values()].map(async item => { await item.accepted?.release?.(); await item.source?.dispose() })))
      sessions.clear()
    },
  }
}
