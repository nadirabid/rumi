/** Explicit revision-bound validation; only tool calls start Bullet and the host's own Blender stages. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createSource, createSourcePresentation } from './source.js'
import { discoverModels } from './catalog.js'
import { normalizePlacement } from './transform.js'
import { parseStl, STL_LIMITS } from './stl.js'
import { validateUsd, USD_MAX_BYTES } from './usd.js'
import { runValidationStage } from '../blender/validation-runner.js'
import { runBullet } from '../bullet/runner.js'
import { validationState, preserveMovement } from './validation-state.js'
import { summarizeValidationReport, summarizeValidationState } from './validation-summary.js'

const POLICY_VERSION = 5
const blocking = report => report.checks.some(check => check.count && check.severity === 'error')
const passedMechanics = report => report?.status === 'passed' && report.assemblyVerified === true && report.coverage?.complete === true

/**
 * Own snapshots, per-stage results, durable movement requirements and cancellation.
 * No turn or project-open event starts checks or follows up with the agent.
 * @param {object} ctx Plugin context for snapshot routes and session disposal.
 * @param {object} config Resolved validator policy and private storage directory.
 * @param {object} options Scene lookup, notifications and optional test runners.
 * @returns {object} Tool execution, viewer reports and quiescent disposal.
 */
export function createValidation(ctx, config, { view, notify, run = runValidationStage, bullet = runBullet }) {
  const sessions = new Map(), jobs = new Map(), disposed = new Set(), controllers = new Set()
  let closed = false
  function sessionFor(id) {
    if (!sessions.has(id)) sessions.set(id, { models: new Map(), busy: false, error: null })
    return sessions.get(id)
  }
  function fingerprint(hash, transform, volume) {
    return createHash('sha256').update(JSON.stringify([POLICY_VERSION, hash, transform, volume, config.validation, config.mechanics])).digest('hex')
  }
  function combined(item) {
    const checks = ['assembly', 'geometry', 'fit'].flatMap(stage => item.stages[stage]?.checks ?? [])
    const mechanics = item.stages.mechanics
    if (mechanics) checks.push(...mechanics.checks)
    return { version: 1, status: checks.some(check => check.count && check.severity === 'error') ? 'needs_repair'
      : checks.some(check => check.count) || !item.acceptedCurrent ? 'review' : 'passed', checks,
      ...(mechanics ? { mechanics } : {}), printReady: false }
  }
  async function prepare(id, cwd, path) {
    const session = sessionFor(id)
    let item = session.models.get(path)
    if (item) { await item.preparing; return item }
    item = { path, stages: {}, status: 'changed', required: { movements: [] } }
    session.models.set(path, item)
    item.preparing = (async () => {
      try {
        item.storage = validationState(config.validationStateDirectory, cwd, path)
        const saved = await item.storage.read()
        item.required = saved.required
        if (saved.accepted) {
          const source = await createSource(ctx, saved.accepted.path, saved.accepted.workspace)
          try {
            if (source.state().contentHash !== saved.accepted.sourceHash) throw new Error('Accepted source bytes do not match their validated revision')
            source.transform(saved.accepted.transform)
            item.accepted = { fingerprint: saved.accepted.fingerprint, presentation: createSourcePresentation({ ...source.state(), path: resolve(cwd, path) }), release: source.dispose }
          } catch (error) { await source.dispose(); throw error }
        }
      } catch (error) { item.status = 'unavailable'; item.error = String(error.message ?? error); throw error }
    })()
    await item.preparing
    return item
  }
  async function scan(id, cwd, signal) {
    const session = sessionFor(id), scene = view(id), seen = new Set()
    const catalog = await discoverModels(cwd)
    for (const model of catalog) {
      signal.throwIfAborted()
      const item = await prepare(id, cwd, model.path)
      seen.add(model.path)
      if (item.error && !item.source) throw new Error(item.error)
      item.source ??= await createSource(ctx, resolve(cwd, model.path), cwd)
      await item.source.poll(); await item.source.poll()
      const state = item.source.state()
      if (state.error) throw new Error(state.error.message)
      const transform = scene.selectedModel === model.path ? scene.transform : normalizePlacement()
      const hash = fingerprint(state.contentHash, transform, scene.volume)
      update(item, hash, { format: state.format, transform, volume: scene.volume }, state.contentHash)
    }
    for (const mesh of scene.meshes) {
      seen.add(mesh.path)
      let item = session.models.get(mesh.path)
      if (!item) { item = { path: mesh.path, stages: {}, required: { movements: [] } }; session.models.set(mesh.path, item) }
      const hash = createHash('sha256').update(mesh.bytes).digest('hex')
      update(item, fingerprint(hash, mesh.transform, scene.volume), { ...mesh, format: 'stl', volume: scene.volume }, hash)
    }
    for (const [path, item] of session.models) if (!seen.has(path)) {
      await item.accepted?.release?.(); await item.source?.dispose(); session.models.delete(path)
    }
    session.error = null
    signal.throwIfAborted()
    notify(id)
  }
  function update(item, hash, input, sourceHash) {
    if (item.fingerprint !== hash) {
      item.previousReport = item.report ?? null
      item.report = null; item.stages = {}; item.preparedGeometry = null; item.acceptedCurrent = false
      item.status = 'changed'; item.error = null
    }
    item.fingerprint = hash; item.input = input; item.sourceHash = sourceHash
  }
  async function bytesFor(id, item, signal) {
    if (item.input.bytes) return item.input.bytes
    if (item.input.format === 'usd') return item.source.snapshotBytes()
    return new Promise((resolveBytes, reject) => {
      const state = item.source.state()
      const finish = (error, bytes) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        item.request = null; item.settle = null
        if (error) reject(error); else resolveBytes(bytes)
      }
      const abort = () => finish(signal.reason ?? new Error('Validation cancelled'))
      const timer = setTimeout(() => finish(new Error('Viewer export timed out; open the preview or publish USD and retry.')), config.validationTimeoutMs)
      item.settle = finish
      item.request = { id: randomUUID(), path: item.path, url: state.url, contentHash: state.contentHash, parameters: state.parameters, fingerprint: item.fingerprint }
      signal.addEventListener('abort', abort, { once: true })
      notify(id)
      if (signal.aborted) abort()
    })
  }
  const failure = (code, message) => ({ status: 'blocked', code, message, printReady: false })
  const titles = { assembly: 'Assembly declarations', geometry: 'Mesh geometry', fit: 'Clearance and fit' }
  async function execute(id, cwd, stage, args, signal) {
    await scan(id, cwd, signal)
    const session = sessionFor(id)
    const item = session.models.get(args.path)
    if (!item) return failure('model_not_found', 'Use the model path from the project, for example models/<name>/model.usda.')
    const fingerprint = item.fingerprint
    if (stage === 'accept' && fingerprint !== args.fingerprint) return failure('stale_revision', 'The model or placement changed. Call validation_mechanics for the new revision, then accept its fingerprint.')
    const current = async () => {
      await scan(id, cwd, signal)
      return session.models.get(args.path) === item && item.fingerprint === fingerprint
    }
    if (stage === 'accept') {
      if (['assembly', 'geometry', 'fit'].some(required => !item.stages[required] || blocking(item.stages[required]))) {
        return failure('prerequisite_required', 'Call validation_mechanics for this revision and fix its findings before acceptance.')
      }
      if (!passedMechanics(item.stages.mechanics)) return failure('mechanics_required', 'Call validation_mechanics and reach complete passing coverage before acceptance.')
      const intent = item.stages.assembly.intent
      const saved = item.storage ? await item.storage.read() : { required: item.required }
      const preserved = preserveMovement(saved.required, intent)
      if (preserved.checks.length) return { ...failure('movement_changed', 'Restore required movement before acceptance.'), checks: preserved.checks }
      if (item.storage) {
        const state = item.source.state()
        state.transform = item.input.transform
        await item.storage.write(preserved.required, { fingerprint: item.fingerprint, state, volume: item.input.volume, source: item.source.snapshot() })
      }
      if (!await current()) return failure('stale_revision', 'The model changed during acceptance; check the new revision.')
      item.acceptedCurrent = true
      if (item.source) {
        const release = item.source.retainSnapshot(), previous = item.accepted
        item.accepted = { fingerprint: item.fingerprint, presentation: createSourcePresentation({ ...item.source.state(), transform: item.input.transform }), release }
        await previous?.release?.()
      } else item.accepted = { fingerprint: item.fingerprint, transform: structuredClone(item.input.transform) }
      item.report = combined(item); item.status = item.report.status; notify(id)
      return { status: 'accepted', path: item.path, fingerprint: item.fingerprint, report: summarizeValidationReport(item.report), printReady: false }
    }
    const stale = () => failure('stale_revision', 'The model changed during validation; discard these findings and call validation_mechanics again.')
    for (const cheap of ['assembly', 'geometry', 'fit']) {
      if (!item.stages[cheap]) {
        item.status = 'checking'; notify(id)
        try {
          if (!await runCheap(id, item, cheap, current, signal)) return stale()
        } catch (error) {
          item.status = 'unavailable'; item.error = String(error.message ?? error)
          throw error
        } finally { notify(id) }
      }
      if (blocking(item.stages[cheap])) {
        return { ...result(item, cheap, false), status: 'blocked', code: 'blocking_findings', bulletStarted: false,
          message: `${titles[cheap]} has blocking errors. Fix them, publish again and call validation_mechanics for the new revision. Bullet was not started.` }
      }
    }
    if (item.stages.mechanics) return result(item, 'mechanics', true)
    if (!item.preparedGeometry) return failure('geometry_unavailable', 'The physical bodies could not be prepared. Publish a complete assembly and call validation_mechanics again.')
    item.status = 'checking'; notify(id)
    try {
      const report = await bullet(config, item.preparedGeometry, signal)
      if (!await current()) return stale()
      item.stages.mechanics = report
      item.report = combined(item); item.status = item.report.status; item.error = null
      return result(item, 'mechanics', false)
    } catch (error) {
      item.status = 'unavailable'; item.error = String(error.message ?? error)
      throw error
    } finally { notify(id) }
  }
  /** Run one Blender stage for the current revision; false when the revision changed meanwhile. */
  async function runCheap(id, item, stage, current, signal) {
    const bytes = await bytesFor(id, item, signal)
    const format = new TextDecoder().decode(bytes.subarray(0, 10)).startsWith('#usda 1.0') ? 'usd' : 'stl'
    const report = await run(config, { ...item.input, format, bytes, volume: stage === 'geometry' ? null : item.input.volume }, signal, stage)
    if (!await current()) return false
    if (stage === 'assembly') {
      const saved = item.storage ? await item.storage.read() : { required: item.required }
      const preserved = preserveMovement(saved.required, report.intent)
      report.checks.push(...preserved.checks)
      if (blocking(report)) report.status = 'needs_repair'
      if (item.storage) await item.storage.write(preserved.required, null)
      item.required = preserved.required
    }
    item.preparedGeometry = report.preparedGeometry ?? item.preparedGeometry
    delete report.preparedGeometry
    item.stages[stage] = report
    item.report = combined(item); item.status = item.report.status; item.error = null
    return true
  }
  function result(item, stage, cached) {
    const report = item.stages[stage]
    return { path: item.path, fingerprint: item.fingerprint, stage, cached, status: report.status,
      report: stage === 'mechanics' ? summarizeValidationReport({ mechanics: report }).mechanics : report, printReady: false }
  }
  function read(id) {
    const session = sessions.get(id), scene = view(id)
    return { error: session?.error ?? null, models: [...(session?.models.values() ?? [])].map(item => {
      const changed = scene.selectedModel === item.path && (scene.analog || fingerprint(scene.sourceHash, scene.transform, scene.volume) !== item.fingerprint)
      return { path: item.path, fingerprint: item.fingerprint, sourceHash: item.sourceHash, status: changed ? 'changed' : item.status,
        completedStages: Object.keys(item.stages), report: changed ? null : item.report ?? null,
        previousReport: changed ? item.report : item.previousReport ?? null, error: item.error ?? null,
        acceptedFingerprint: item.accepted?.fingerprint ?? null, requiredMovement: item.required }
    }) }
  }
  ctx.on('session/disposed', async session => {
    disposed.add(session.id)
    for (const controller of controllers) if (controller.sessionId === session.id) controller.abort()
    await Promise.allSettled([...jobs].filter(([, id]) => id === session.id).map(([job]) => job))
    const record = sessions.get(session.id)
    sessions.delete(session.id)
    for (const item of record?.models.values() ?? []) { await item.accepted?.release?.(); await item.source?.dispose() }
  })
  return {
    read,
    /** Execute an exclusive, cancellable stage; findings return, infrastructure failures reject. */
    async execute(id, cwd, stage, args, signal) {
      if (closed || disposed.has(id)) throw new Error('Validation is closed')
      if (!['mechanics', 'accept'].includes(stage)) throw new Error('Unknown validation stage')
      const session = sessionFor(id)
      if (session.busy) return failure('validation_busy', 'Wait for this project’s current validation tool to finish.')
      session.busy = true
      const controller = new AbortController()
      controller.sessionId = id
      controllers.add(controller)
      const abort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const job = execute(id, cwd, stage, args, controller.signal)
      jobs.set(job, id)
      try { return await job }
      catch (error) { session.error = String(error.message ?? error); notify(id); throw error }
      finally { session.busy = false; jobs.delete(job); controllers.delete(controller); signal.removeEventListener('abort', abort) }
    },
    /** Restore accepted history without launching validation. */
    async restore(id, cwd, path) {
      if (closed || disposed.has(id) || !path) return
      const job = prepare(id, cwd, path)
      jobs.set(job, id)
      try { await job } catch (error) { sessionFor(id).error = String(error.message ?? error) }
      finally { jobs.delete(job) }
    },
    presentation(id, path) { return sessions.get(id)?.models.get(path)?.accepted?.presentation?.state() ?? null },
    meshPlacement(id, path) { return sessions.get(id)?.models.get(path)?.accepted?.transform ?? null },
    requests(id) { return [...(sessions.get(id)?.models.values() ?? [])].flatMap(item => item.request ? [item.request] : []) },
    submit(id, requestId, bytes, error) {
      const item = [...(sessions.get(id)?.models.values() ?? [])].find(item => item.request?.id === requestId)
      if (!item || closed) return false
      if (error !== null) { item.settle(new Error(error.slice(0, 2000))); return true }
      const usd = new TextDecoder().decode(bytes.subarray(0, 10)).startsWith('#usda 1.0')
      if (bytes.byteLength > (usd ? USD_MAX_BYTES : STL_LIMITS.maxBytes)) throw new Error('Validation mesh exceeds its format limit')
      if (usd) validateUsd(bytes); else parseStl(bytes)
      item.settle(null, bytes)
      return true
    },
    /** Cancel tools, await children, then release snapshot routes. */
    async dispose() {
      closed = true
      for (const controller of controllers) controller.abort()
      await Promise.allSettled([...jobs.keys()])
      for (const session of sessions.values()) for (const item of session.models.values()) { await item.accepted?.release?.(); await item.source?.dispose() }
      sessions.clear()
    },
  }
}
