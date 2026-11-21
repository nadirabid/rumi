import { usdRequiresSeparatePrint } from './usd.js'
/**
 * The mesh preview capability: a session-owned scene, the routes the browser
 * reads it through, and the tools that edit it.
 *
 * Content and composition are separate. Opening a file stores a datablock —
 * geometry, its published bytes, and the centre its rotation turns around — and
 * places one object. Every later change is a scene command, so turning or
 * resizing never rewrites a mesh, and the browser renders the same geometry it
 * already fetched.
 */
import { checkControlGeometry } from '../blender/control-geometry.js'
import { registerPrintLayout } from './print-layout/host.js'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { analyzeMesh } from './checks.js'
import { createHistory } from './document.js'
import { STL_LIMITS, encodeStl, parseStl } from './stl.js'
import { USD_MAX_BYTES } from './usd.js'
import { placeMesh } from './transform.js'

import { createViewerDiagnostics } from './diagnostics.js'
import { createHighlightReceipts } from './receipts.js'
import { createLoadReceipts } from './load-receipts.js'
import { createViewerEvents } from './events.js'
import { createCursorRequests, cursorIdentity } from './cursor.js'
import { createModelFocus } from './model-focus.js'
import { createValidation } from './validation.js'
import { registerValidationTools } from './validation-tools.js'
import { summarizeValidationState } from './validation-summary.js'
import { createSource } from './source.js'
import { discoverModels, readSelection, saveSelection } from './catalog.js'
import { modelRegionReference } from './model-regions.js'

const ROUTE = '/api/print-studio/viewer'
const JSON_HEADERS = { 'cache-control': 'private, no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }
/** A datablock never changes once opened, so its bytes stay cacheable for the page's lifetime. */
const MESH_HEADERS = { 'cache-control': 'private, max-age=3600, immutable', 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' }
const MAX_SESSIONS = 8

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/**
 * The one object a command means when the caller did not name one.
 * @param {object} record - Session record.
 * @param {string} intent - Tool name, for the failure message.
 * @returns {string} the only object's id.
 * @throws {Error} When the scene holds zero or several objects.
 */
/**
 * The datablock for one file, reusing the last one opened at that path when the
 * bytes are unchanged. Reopening a part therefore places a second object that
 * shares the geometry the browser already has.
 * @param {object} record - Session record.
 * @param {string} path - Path the bytes were read from.
 * @param {Float32Array} positions - Parsed geometry.
 * @param {ArrayBuffer} bytes - Canonical encoding sent to the browser.
 * @returns {string} the datablock id.
 */
function datablockFor(record, path, positions, bytes) {
  const existing = record.datablocks.get(record.byPath.get(path))
  if (existing !== undefined && sameBytes(existing.bytes, bytes)) return record.byPath.get(path)
  const id = crypto.randomUUID()
  record.datablocks.set(id, { name: basename(path), positions, bytes })
  record.byPath.set(path, id)
  return id
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function onlyObject(record, intent) {
  const { objects } = record.history.current()
  if (objects.length === 1) return objects[0].id
  throw new Error(`${intent} needs an objectId when the scene holds ${objects.length === 0 ? 'no objects' : `${objects.length} objects`}`)
}

/**
 * Measure one object as the scene composes it.
 * @param {object} record - Session record holding the datablocks.
 * @param {object} object - Scene object.
 * @returns {object} the analysis of the transformed mesh.
 */
function measureObject(record, object) {
  const datablock = record.datablocks.get(object.datablockId)
  const placed = placeMesh(datablock.positions, object.transform)
  return { matrix: placed.matrix, report: analyzeMesh(placed.positions, { volume: record.history.current().volume }) }
}

/**
 * Re-measure the objects a command changed.
 * @param {object} record - Session record.
 * @param {string[]} [objectIds] - Objects to re-measure; omitted re-measures the whole scene.
 * @returns {void}
 */
function refresh(record, objectIds) {
  const { objects } = record.history.current()
  for (const object of objects) {
    if (objectIds !== undefined && !objectIds.includes(object.id)) continue
    record.measurements.set(object.id, measureObject(record, object))
  }
  for (const id of [...record.measurements.keys()]) {
    if (!objects.some(object => object.id === id)) record.measurements.delete(id)
  }
}

function summaryOf(record) {
  const measured = [...record.measurements.values()].map(measurement => measurement.report)
  const designReport = record.source?.state().report
  if (designReport) measured.push(designReport)
  const errors = measured.reduce((total, report) => total + report.checks.filter(check => check.severity === 'error').length, 0)
  const warnings = measured.reduce((total, report) => total + report.checks.filter(check => check.severity === 'warning').length, 0)
  const pending = measured.some(report => report.checks.some(check => check.severity === 'pending'))
  return { status: errors > 0 ? 'blocked' : warnings > 0 || pending ? 'review' : 'ok', errors, warnings }
}

/**
 * What the browser needs to draw the scene: placement matrices, statuses, and
 * no measurements.
 * @param {object} record - Session record.
 * @returns {object} the view state.
 */
function sceneState(record) {
  const scene = record.history.current()
  return {
    revision: scene.revision,
    volume: scene.volume,
    summary: summaryOf(record),
    objects: scene.objects.map((object) => {
      const measurement = record.measurements.get(object.id)
      return {
        id: object.id,
        datablockId: object.datablockId,
        name: object.name,
        visible: object.visible,
        matrix: measurement.matrix,
        blocked: measurement.report.status === 'blocked',
      }
    }),
  }
}

/**
 * What an agent needs to talk about the scene: placements and measurements.
 * @param {object} record - Session record.
 * @returns {object} the report.
 */
function sceneReport(record) {
  const scene = record.history.current()
  return {
    volume: scene.volume,
    objectCount: scene.objects.length,
    ...summaryOf(record),
    design: record.source?.state() ?? null,
    models: record.models ?? [],
    selectedModel: record.selectedModel ?? null,
    discoveryError: record.catalogError ?? null,
    objects: scene.objects.map((object) => {
      const { report } = record.measurements.get(object.id)
      return {
        id: object.id,
        name: object.name,
        datablockId: object.datablockId,
        visible: object.visible,
        transform: object.transform,
        dimensions: report.dimensions,
        status: report.status,
        suggested: report.suggested,
        checks: report.checks,
      }
    }),
  }
}

/** Keep sampled geometry out of conversational context; frozen recipe files retain every offset. */
function modelContextJson(value) {
  return JSON.stringify(value, (key, entry) => key === 'fields' && Array.isArray(entry)
    ? entry.map(({ offsets, ...field }) => ({ ...field, offsetCount: offsets.length })) : entry)
}

/** Exact source and measurement context awaited by viewer_load. */
function loadIdentity(record) {
  const design = record.source?.state()
  return design ? { path: design.path, revision: design.revision, url: design.url,
    transform: design.transform, volume: record.history.current().volume, ...(design.renderRequest ? { renderRequest: design.renderRequest } : {}) } : null
}

/**
 * Register the preview routes and the scene tools.
 * @param {object} ctx - Cordis host context with connection, tools, fs, and workingDirectory.
 * @param {Function} defineTool - DSH's schema-validating tool factory from the host entrypoint.
 * @param {string} diagnosticsDirectory - Private local journal directory.
 * @param {number} loadTimeoutMs - Maximum renderer acknowledgment wait, in milliseconds.
 * @param {object} [validationConfig] Resolved validator settings; omitted by isolated viewer fixtures.
 * @returns {void}
 */
export function applyViewer(ctx, defineTool, diagnosticsDirectory, loadTimeoutMs, validationConfig) {
  const diagnostics = createViewerDiagnostics(diagnosticsDirectory)
  const sessions = new Map()
  const receipts = createHighlightReceipts()
  const loads = createLoadReceipts(loadTimeoutMs)
  const events = createViewerEvents()
  const focus = createModelFocus(ctx, {
    read: id => sessions.get(id), notify: id => events.notify(id),
    readRegion: id => attachedRegion(sessions.get(id)),
  })
  function referenceRegion(record, id) {
    const design = record?.source?.state(), highlight = design?.highlight
    if (!id || !design || design.error) return null
    const source = { id, path: design.path, revision: design.revision, url: design.url }
    if (highlight?.regionName && highlight.id === id) return { ...source, name: highlight.regionName, meshPath: highlight.meshPath }
    if (!design.regionMap) return null
    const region = [...design.regionMap.regions, design.regionMap.remainder].find(item => modelRegionReference(design, item.id) === id)
    return region ? { ...source, name: region.name, regionId: region.id } : null
  }
  function attachedRegion(record) {
    return referenceRegion(record, record?.regionReference)
  }
  const validation = validationConfig ? createValidation(ctx, validationConfig, {
    notify: id => events.notify(id),
    view: id => {
      const record = sessions.get(id), scene = record?.history.current(), design = record?.source?.state()
      return { selectedModel: record?.selectedModel, transform: design?.transform,
        sourceHash: design?.contentHash, analog: design?.analog, volume: scene?.volume ?? null, meshes: (scene?.objects ?? []).filter(object => object.visible).map(object => ({
          path: `stl:${object.id}`, bytes: new Uint8Array(record.datablocks.get(object.datablockId).bytes), transform: object.transform,
        })) }
    },
  }) : null
  if (validation) registerValidationTools(ctx, defineTool, validation, validationConfig)
  const displaySource = record => record.source
  const displayIdentity = record => cursorIdentity({ ...record, source: displaySource(record) })
  const cursors = createCursorRequests(sessionId => events.notify(sessionId))
  const captureJobs = new Set(), evictions = new Set()
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'rumi:naming-model-regions', order: scoped.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: 'Keep a complete hover-name map beside each USD model you create or revise. If the current editable model is your work target and meshState.design.regionStatus is missing, outdated, or invalid, inspect its distinct features and write its map in the same modeling turn. See clarify-mesh-changes. Use short, familiar names in the person’s language, and use a precise feature name when it helps the person describe a future edit.',
    }), 'print viewer: name model features')
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:mesh-state', order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'), interpolate: false, required: true,
      text: ({ agent }) => {
        if (!agent) return ''
        const record = sessions.get(agent.session.id)
        return modelContextJson({ meshState: record
          ? { ...sceneReport(record), ...(validation ? { displayedDesign: record.source?.state() ?? null } : {}), validation: summarizeValidationState(validation?.read(agent.session.id)), workingModels: focus.paths(agent.session.id) }
          : { status: 'unavailable', reason: 'viewer_not_initialized', validation: summarizeValidationState(validation?.read(agent.session.id)) } })
      },
    }), 'print viewer: live mesh context')
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:active-shape', order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'), interpolate: false, required: true,
      text: context => {
        const shape = sessions.get(context.agent?.session.id)?.source?.state().analog
        const review = sessions.get(context.agent?.session.id)?.source?.controlReview.state()
        if (review) return `Pending mesh control review: ${JSON.stringify(review)}. Do not claim controls are ready before presenting reviewed controls. Validation renders are evidence, not an automatic quality pass. Inspect every comparison for the expected effect, unwanted movement, pinching, intersections, and part fit.`
        if (!shape) return sessions.get(context.agent?.session.id)?.source ? 'No temporary mesh controls are staged or presented.' : ''
        return `Unresolved model edit: ${JSON.stringify({ id: shape.id, label: shape.label, operation: shape.operation, controls: shape.controls, values: shape.values, frozen: shape.frozen, finish: shape.finish, original: shape.original, edit: shape.edit })}. Keep controls open while the person explores. Satisfaction or moving to another task resolves the current edit first: freeze the latest visible values, then ${shape.operation === 'parameters' && shape.finish !== 'blender' ? 'call viewer_controls save with the frozen id' : 'apply the captured recipe in Blender, publish and load the revision'}. If already frozen, finish saving. Explicit cancel uses close. Read mesh-edit-controls; do not require a special phrase.`
      },
    }), 'print-studio active edit context')
  })
  let closed = false
  ctx.effect(() => async () => {
    closed = true
    await validation?.dispose()
    await Promise.allSettled([...evictions])
    loads.dispose()
    receipts.dispose()
    events.dispose()
    cursors.dispose()
    await Promise.allSettled([...captureJobs])
    await Promise.all([...sessions.values()].map(record => record.pending))
    sessions.clear()
    diagnostics.close()
  }, 'print-studio: preview scenes')
  const route = (path, fetch) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods: ['GET'], requestBody: 'buffered', fetch,
  }), `print-studio: preview ${path || 'state'}`)

  /**
   * The session's scene record, created on first use and dropped least recently used.
   * @param {string} sessionId - Conversation id.
   * @returns {object} the record.
   */
  function recordFor(sessionId) {
    if (closed) throw new Error('Mesh preview is closed')
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      sessions.delete(sessionId)
      sessions.set(sessionId, existing)
      return existing
    }
    const record = { sessionId, history: createHistory(), datablocks: new Map(), byPath: new Map(), measurements: new Map(), pending: Promise.resolve() }
    sessions.set(sessionId, record)
    while (sessions.size > MAX_SESSIONS) {
      const key = [...sessions.keys()].find(id => id !== sessionId && !sessions.get(id).busy && !validation?.busy(id) && focus.paths(id).length === 0)
      if (key === undefined) break
      const source = sessions.get(key).source
      const eviction = Promise.all([validation?.release(key), source?.dispose()])
      evictions.add(eviction)
      void eviction.then(() => evictions.delete(eviction), error => {
        evictions.delete(eviction)
        ctx.logger.warn('Failed to release an inactive model preview', error)
      })
      loads.cancel(key)
      receipts.cancel(key)
      events.forget(key)
      cursors.cancel(key)
      sessions.delete(key)
    }
    return record
  }

  // Selection and discovery share a queue so a late automatic load cannot replace a user's selection.
  function serialize(record, operation) {
    record.busy = (record.busy ?? 0) + 1
    const result = record.pending.then(() => {
      if (closed) throw new Error('Model preview is closed')
      return operation()
    })
    record.pending = result.then(() => {}, () => {}).finally(() => { record.busy-- })
    return result
  }

  async function directoryFor(sessionId, record) {
    if (record.cwd) return record.cwd
    const observation = await ctx.sessionQuery.observeSession(sessionId)
    try {
      const cwd = observation.projections?.values.workingDirectory ?? observation.header.cwd
      if (!cwd) throw new Error('Model preview requires a project directory')
      record.cwd = cwd
      return cwd
    } finally { observation[Symbol.dispose]() }
  }

  async function loadSource(record, cwd, path, volume, signal) {
    signal?.throwIfAborted()
    if (closed) throw new Error('Model preview is closed')
    const candidate = await createSource(ctx, resolve(cwd, path), cwd)
    const previous = record.source?.state(), next = candidate.state()
    const retained = previous?.path === next.path && previous.contentHash === next.contentHash
    const source = retained ? record.source : candidate
    try {
      signal?.throwIfAborted()
      if (closed) throw new Error('Model preview is closed')
      const selected = relative(cwd, resolve(cwd, path)).split(sep).join('/')
      await saveSelection(cwd, selected, volume === undefined ? record.history.current().volume : volume)
      if (closed) throw new Error('Model preview is closed')
      if (retained) {
        await candidate.dispose()
        source.requestRender()
      } else await record.source?.dispose()
      record.source = source
      record.cwd = cwd
      record.selectedModel = selected
      record.catalogError = null
      if (volume !== undefined) {
        record.history.apply({ type: 'setVolume', volume })
        refresh(record)
      }
      loads.update(record.sessionId, loadIdentity(record))
    } catch (error) {
      await candidate.dispose()
      throw error
    }
  }

  async function discover(sessionId, record) {
    const cwd = await directoryFor(sessionId, record)
    record.models = await discoverModels(cwd)
    if (!record.source && record.history.current().objects.length === 0) {
      const saved = await readSelection(cwd)
      const path = saved?.path ?? record.models[0]?.path
      if (path) await loadSource(record, cwd, path, saved?.volume)
    }
    await record.source?.poll()
    await validation?.refresh(sessionId, cwd)
    loads.update(sessionId, loadIdentity(record), record.source?.state().error?.kind === 'source'
      ? { status: 'source_failed', error: record.source.state().error } : undefined)
    record.catalogError = null
  }

  if (validationConfig?.printLayout) registerPrintLayout(ctx, (sessionId, operation) => {
    const record = recordFor(sessionId)
    return serialize(record, async () => {
      await discover(sessionId, record)
      const design = record.source?.state()
      if (!design || design.error?.kind === 'source') throw new Error('Load a model before arranging it')
      return operation({ design, requiresSeparatePrint: usdRequiresSeparatePrint(record.source.snapshotBytes()), cwd: await directoryFor(sessionId, record), model: record.selectedModel, volume: record.history.current().volume })
    })
  }, validationConfig.printLayout)

  route('/events', async request => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const after = Number(url.searchParams.get('after'))
    if (!sessionId || !Number.isSafeInteger(after) || after < 0) return json({ error: 'invalid_event_cursor' }, 400)
    const event = await events.wait(sessionId, after, request.signal)
    if (receipts.has(sessionId)) diagnostics.record(sessionId, 'viewer.event_delivered', { version: event.version })
    return json(event)
  })

  route('/state', async (request) => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId) return json({ error: 'session_required' }, 400)
    const record = recordFor(sessionId)
    await serialize(record, async () => {
      try { await discover(sessionId, record) }
      catch (error) { record.catalogError = String(error) }
    })
    if (receipts.has(sessionId)) diagnostics.record(sessionId, 'viewer.state_delivered', { highlightId: displaySource(record)?.state().highlight?.id ?? null })
    const displayed = sceneState(record)
    return json({ controlValidationRequest: record.source?.controlReview.request() ?? null, validationRequests: validation?.requests(sessionId) ?? [], cursorRequest: cursors.read(sessionId), scene: {
      validation: validation?.read(sessionId),
      ...displayed, design: record.source?.state() ?? null,
      models: record.models ?? [], selectedModel: record.selectedModel ?? null,
      workingModels: focus.paths(sessionId), agentRunning: focus.running(sessionId),
      catalogFailed: Boolean(record.catalogError), regionReference: attachedRegion(record),
    } })
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/select`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId) return json({ error: 'session_required' }, 400)
      let value
      try { value = JSON.parse(await request.text()) }
      catch (_error) { return json({ error: 'invalid_selection' }, 400) }
      if (typeof value?.path !== 'string') return json({ error: 'invalid_selection' }, 400)
      const record = recordFor(sessionId)
      try {
        await serialize(record, async () => {
          const cwd = await directoryFor(sessionId, record)
          record.models = await discoverModels(cwd)
          if (!record.models.some(model => model.path === value.path)) throw new Error('Model entry not found')
          await loadSource(record, cwd, value.path)
        })
        events.notify(sessionId)
        return json({ ok: true })
      } catch (_error) { return json({ error: 'selection_failed' }, 409) }
    },
  }), 'print viewer: select model')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/validation`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const url = new URL(request.url), id = url.searchParams.get('sessionId'), job = url.searchParams.get('id')
      if (!id || !job || !validation) return json({ error: 'validation_not_found' }, 404)
      try {
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > USD_MAX_BYTES) return json({ error: 'mesh_too_large' }, 413)
        const error = request.headers.get('content-type') === 'text/plain' ? new TextDecoder().decode(bytes) : null
        return validation.submit(id, job, bytes, error) ? json({ ok: true }) : json({ error: 'stale_validation' }, 409)
      } catch (_error) { return json({ error: 'invalid_validation_mesh' }, 400) }
    },
  }), 'print viewer: validation geometry')

  route('/highlight-mesh', async request => {
    const query = new URL(request.url).searchParams
    const record = sessions.get(query.get('sessionId'))
    const mesh = record?.highlightMesh
    if (!mesh || mesh.id !== query.get('id') || displaySource(record)?.state().highlight?.id !== mesh.id) return json({ error: 'highlight_not_found' }, 404)
    return new Response(mesh.bytes.slice(0), { headers: MESH_HEADERS })
  })

  route('/model', async (request) => {
    const query = new URL(request.url).searchParams
    const sessionId = query.get('sessionId')
    const datablock = sessionId === null ? undefined : sessions.get(sessionId)?.datablocks.get(query.get('datablockId'))
    if (datablock === undefined) return json({ error: 'preview_not_found' }, 404)
    return new Response(datablock.bytes.slice(0), { headers: MESH_HEADERS })
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/trace`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessions.has(sessionId)) return json({ error: 'preview_not_found' }, 404)
      const body = await request.text()
      if (body.length > 2048) return json({ error: 'trace_too_large' }, 413)
      let value
      try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_trace' }, 400) }
      if (!value || typeof value.highlightId !== 'string' || value.highlightId.length > 128
        || !['apply_started', 'apply_finished', 'feedback_started', 'feedback_failed', 'feedback_delivered', 'apply_or_feedback_failed', 'effect_disposed'].includes(value.phase)
        || typeof value.hidden !== 'boolean'
        || !['receivedAt', 'elapsedMs', 'width', 'height'].every(key => Number.isFinite(value[key]) && value[key] >= 0)) return json({ error: 'invalid_trace' }, 400)
      diagnostics.record(sessionId, `client.${value.phase}`, {
        highlightId: value.highlightId, hidden: value.hidden, receivedAt: value.receivedAt,
        elapsedMs: value.elapsedMs, width: value.width, height: value.height,
      })
      return json({ ok: true })
    },
  }), 'print viewer: client diagnostics')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/feedback`, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      const displayedRecord = sessions.get(sessionId)
      const source = displayedRecord && displaySource(displayedRecord)
      if (!source) return json({ error: 'preview_not_found' }, 404)
      const body = await request.text()
      if (body.length > 32_000) return json({ error: 'feedback_too_large' }, 413)
      let value
      try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_feedback' }, 400) }
      if (!value || !Number.isInteger(value.revision)) return json({ error: 'invalid_feedback' }, 400)
      if (value.highlightId || value.requestedHighlightId || receipts.has(sessionId)) {
        const current = source.state()
        diagnostics.record(sessionId, 'viewer.feedback_received', {
          highlightId: value.highlightId ?? null, requestedHighlightId: value.requestedHighlightId ?? null, expectedHighlightId: current.highlight?.id ?? null,
          revisionMatches: value.revision === current.revision, urlMatches: value.url === current.url,
          transformMatches: JSON.stringify(value.transform) === JSON.stringify(current.transform),
          client: value.diagnostics ? { hidden: value.diagnostics.hidden === true, elapsedMs: Number.isFinite(value.diagnostics.elapsedMs) ? value.diagnostics.elapsedMs : null, width: Number.isFinite(value.diagnostics.width) ? value.diagnostics.width : null, height: Number.isFinite(value.diagnostics.height) ? value.diagnostics.height : null } : null, highlightStatus: value.highlightStatus ?? null, hasError: Boolean(value.error),
        })
      }
      if (value.renderRequest !== source.state().renderRequest) return json({ error: 'stale_render_feedback' }, 409)
      try { source.feedback(value) } catch (_error) { diagnostics.record(sessionId, 'viewer.feedback_rejected', { reason: 'invalid_report' }); return json({ error: 'invalid_feedback' }, 400) }
      const current = source.state()
      const record = sessions.get(sessionId)
      if (record?.source === source && value.revision === current.revision && value.url === current.url
        && JSON.stringify(value.transform) === JSON.stringify(current.transform)
        && JSON.stringify(value.volume) === JSON.stringify(record.history.current().volume)
        && value.renderRequest === current.renderRequest) {
        const status = current.error ? current.error.kind === 'source' ? 'source_failed' : 'build_failed'
          : value.loadStatus === 'viewer_hidden' ? 'viewer_hidden'
          : value.loadStatus === 'ready' && current.report ? 'ready' : null
        if (status) loads.update(sessionId, loadIdentity(record), {
          status, scene: structuredClone(sceneReport(record)), ...(current.error ? { error: current.error } : {}),
        })
      }
      if (value.highlightId && value.highlightId === current.highlight?.id
        && value.revision === current.revision && value.url === current.url
        && JSON.stringify(value.transform) === JSON.stringify(current.transform)) {
        diagnostics.record(sessionId, 'highlight.acknowledged', { highlightId: value.highlightId })
        receipts.acknowledge(sessionId, value.highlightId)
      }
      if (value.requestedHighlightId === current.highlight?.id
        && value.revision === current.revision && value.url === current.url
        && JSON.stringify(value.transform) === JSON.stringify(current.transform)
        && ['viewer_hidden', 'render_failed', 'print_layout', 'highlight_hidden'].includes(value.highlightStatus)) {
        receipts.fail(sessionId, value.requestedHighlightId, value.highlightStatus)
      }
      return json({ ok: true })
    },
  }), 'print viewer: build feedback')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/cursor`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      const record = sessions.get(sessionId)
      if (!record) return json({ error: 'preview_not_found' }, 404)
      const body = await request.text()
      if (body.length > 3_100_000) return json({ error: 'snapshot_too_large' }, 413)
      let value
      try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_snapshot' }, 400) }
      if (typeof value?.requestId !== 'string') return json({ error: 'invalid_snapshot' }, 400)
      return serialize(record, async () => {
        await record.source?.poll()
        try {
          const snapshot = displaySource(record)?.state().error ? { status: 'stale_view' } : value.snapshot
          const accepted = cursors.deliver(sessionId, value.requestId, snapshot, displayIdentity(record))
          return json({ accepted }, accepted ? 200 : 409)
        } catch (_error) { return json({ error: 'invalid_snapshot' }, 400) }
      })
    },
  }), 'print viewer: cursor response')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/region-reference`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      const record = sessions.get(sessionId)
      if (!record) return json({ error: 'preview_not_found' }, 404)
      const body = await request.text()
      if (body.length > 2048) return json({ error: 'invalid_region_reference' }, 400)
      let value
      try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_region_reference' }, 400) }
      if (typeof value?.id !== 'string' || typeof value.attach !== 'boolean') return json({ error: 'invalid_region_reference' }, 400)
      return serialize(record, async () => {
        if (value.attach) {
          await record.source?.poll()
          if (!referenceRegion(record, value.id)) return json({ error: 'stale_region' }, 409)
          record.regionReference = value.id
        } else if (record.regionReference === value.id) delete record.regionReference
        events.notify(sessionId)
        return json({ regionReference: attachedRegion(record) })
      })
    },
  }), 'print viewer: attach named region to chat')

  ctx.inject(['liveVoice'], scoped => {
    scoped.effect(() => scoped.liveVoice.register({
      id: 'print-studio-pointing',
      instructions: () => 'Delegate all requests about what to highlight or change in the model, including ambiguous requests. The modeling assistant interprets the spoken request with the captured cursor reference, asks for any needed clarification, and confirms the requested highlight using viewer_highlight. Wait for the rendered result before describing a visible highlight. When mesh shaping controls are active, delegate satisfaction, completion, cancellation, and changes of topic so the modeling assistant can resolve the current edit and clear its controls and highlight before proceeding. Do not merely acknowledge that it is done.',
      captureRequest: async ({ sessionId, requestedAt, signal }) => {
        if (!sessions.has(sessionId)) return []
        const record = sessions.get(sessionId)
        const displayed = displaySource(record)?.state()
        const selectionAtSpeech = { path: record.selectedModel ?? null, revision: displayed?.revision ?? null }
        const { image, ...snapshot } = JSON.parse(await captureReference(sessionId, signal))
        return [{ type: 'text', text: JSON.stringify({
          reference: 'cursor-at-start-of-spoken-request', requestedAt, selectionAtSpeech, snapshot,
          instruction: 'Use this reference for pointing in this request, not a later live cursor position. Highlight the intended area to establish a visual reference. Follow the user’s requested action; ask for clarification when their intent is ambiguous.',
        }) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
      },
    }), 'print viewer: spoken pointing references')
  })

  async function captureReference(sessionId, signal) {
    if (closed) return JSON.stringify({ status: 'viewer_unavailable', reason: 'viewer_closed' })
    const capture = (async () => {
        const record = sessions.get(sessionId)
        if (!record) return JSON.stringify({ status: 'viewer_unavailable', reason: 'viewer_not_open' })
        const identity = await serialize(record, async () => { await record.source?.poll(); return displayIdentity(record) })
        if (displaySource(record)?.state().error) return JSON.stringify({ status: 'stale_view' })
        const snapshot = await cursors.request(sessionId, identity, signal)
        signal.throwIfAborted()
        if (snapshot.status !== 'captured') return JSON.stringify(snapshot)
        try {
          const image = await ctx.attachments.saveImage({
            data: Buffer.from(snapshot.image.slice('data:image/png;base64,'.length), 'base64'),
            mediaType: 'image/png', name: 'Cursor region.png',
          })
          signal.throwIfAborted()
          return JSON.stringify({ ...snapshot, image })
        } catch (error) {
          signal.throwIfAborted()
          return JSON.stringify({ status: 'capture_failed', message: 'The cursor image could not be stored. Retry the snapshot before interpreting the region.' })
        }
    })()
    captureJobs.add(capture)
    try { return await capture }
    finally { captureJobs.delete(capture) }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_cursor_snapshot',
    description: 'Read the pinned blue region or fresh hover hit, with a PNG and model identity. For each new pointing request, call this tool before choosing a region unless that request includes its own cursor-at-start-of-spoken-request capture. Use region.modelLocalPoint (saved model XYZ millimetres), partPath, faceIndex and selection scope to build the overlay. During Movement, the image and worldPoint describe the posed preview; modelLocalPoint maps the hit back to the saved source for viewer_highlight and editing. Verify the capture identity matches the current revision. If capture fails, ask for a fresh pin or resolve the reported viewer issue before choosing a region. Never reuse a capture from another request or guess where the person pointed.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => {
      const { image, ...snapshot } = JSON.parse(value)
      return [{ type: 'text', text: JSON.stringify(snapshot) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
    } },
    presentCall: () => ({ card: 'generic', title: 'Inspect cursor region', kind: 'read' }),
    isConcurrencySafe: () => true, timeoutMs: 10_000,
    async execute(_args, exec) {
      return captureReference(exec.agent?.session.id, exec.signal)
    },
  })), 'print viewer: inspect cursor')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_working_model',
    description: 'Declare which existing model you are actively inspecting or editing. Shows a green dot without changing the user selection. Use a path from meshState.models; call before work and when changing targets. Omit path to clear before clarification or unrelated work. The host also clears it when your agent stops or is disposed. This declaration does not authorize edits or resolve ambiguous references.',
    parameters: { path: { type: 'string', description: 'Discovered model entry path. Omit to clear the work indicator.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 10_000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Model work requires a conversation')
      const record = recordFor(exec.agent.session.id)
      let path = null
      if (args.path !== undefined) {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        record.models = await discoverModels(cwd)
        path = relative(cwd, resolve(cwd, args.path)).split(sep).join('/')
        if (!record.models.some(model => model.path === path)) throw new Error('Model entry not found; read the current meshState context')
      }
      exec.signal.throwIfAborted()
      if (closed) throw new Error('Model preview is closed')
      focus.set(exec.agent, path)
      return JSON.stringify({ workingModel: path, selectedModel: record.selectedModel ?? null })
    },
  })), 'print viewer: declare working model')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_load',
    description: 'Select a Blender-exported USD in the Three.js viewer. Use models/<name>/model.usda; the viewer discovers these entries and reloads completed exports automatically. '
      + 'USD uses metres and Z up; the viewer converts to millimetres and Z up for measurements, placement and Gaussian regions. '
      + 'Use blender_status and the blender-modeling skill for editing with background Blender scripts. Keep .blend originals and revision exports. '
      + 'Self-contained static USD only, at most 64 MiB and 200,000 preview triangles. Preserve detailed originals when making a lighter preview. '
      + 'Executable .js/.mjs previews are disabled by project isolation; export USD instead. '
      + 'Reloading identical source bytes preserves staged controls and their review while requesting fresh renderer feedback. Changed source bytes invalidate them. '
      + 'Saved models display immediately; use validation_mechanics then validation_accept before claiming acceptance. '
      + 'Waits for renderer feedback for the exact source revision, placement and build volume. Returns load.status ready with design.report measurements and effective design.parameters, or an explicit build_failed, source_failed, viewer_hidden, timeout, superseded, cancelled or unavailable outcome. Only ready acknowledges a visible rendered model; timeout is not evidence of an unsupported model. Loading does not certify print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'Model entry to bring into view, for example models/helmet/model.usda.' },
      buildVolume: {
        type: 'object', additionalProperties: false,
        description: 'Printable volume in millimetres. Omit to retain the scene’s current print context.',
        properties: {
          x: { type: 'number', required: true, description: 'Width in millimetres.' },
          y: { type: 'number', required: true, description: 'Depth in millimetres.' },
          z: { type: 'number', required: true, description: 'Height in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 30_000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Model preview requires a conversation')
      const volume = args.buildVolume === undefined ? undefined
        : createHistory().apply({ type: 'setVolume', volume: args.buildVolume }).volume
      const sessionId = exec.agent.session.id
      const record = recordFor(sessionId)
      let completion, requested, initialScene
      const disposeLoad = ctx.effect(async () => {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        exec.signal.throwIfAborted()
        if (closed) throw new Error('Model preview is closed')
        await serialize(record, async () => {
          await loadSource(record, cwd, args.path, volume, exec.signal)
          record.models = await discoverModels(cwd)
          exec.signal.throwIfAborted()
          requested = loadIdentity(record)
          initialScene = structuredClone(sceneReport(record))
          completion = loads.wait(sessionId, requested, exec.signal)
          events.notify(sessionId)
        })
        return () => {}
      }, 'print viewer: load model')
      await disposeLoad
      if (closed) throw new Error('Model preview is closed')
      const { scene = initialScene, ...outcome } = await completion
      return JSON.stringify({ ...scene, load: { ...outcome, requested } }, undefined, 2)
    },
  })), 'print viewer: load source')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_transform',
    description: 'Place the source model without changing its code. Rotation is in degrees about its centre; position is the bottom centre in millimetres. Placement survives source edits.',
    parameters: {
      scale: { type: 'number', description: 'Positive uniform scale.' },
      rotate: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      position: { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      if (!record?.source) throw new Error('Load a model with viewer_load first')
      focus.assertSelected(exec.agent, record.selectedModel)
      record.source.transform(Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)))
      loads.update(exec.agent.session.id, loadIdentity(record))
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print viewer: source placement')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_highlight',
    description: 'Draw a temporary teal triangle mesh on the editable model. Generate an ASCII or binary STL in the project (outside the watched model directory). Copy evaluated surface triangles, or clip them to the desired boundary. Include part transforms and use model-local millimetres, Z up, before viewer placement. Disconnected patches are supported. Triangles are drawn directly and depth-tested. Use the current displayedDesign identity. Empty meshPath clears. Supply regionName when the highlighted geometry identifies a feature the person could refer to, such as Tail tip or Neck seam. Wait for rendered before describing the overlay as visible. See clarify-mesh-changes.',
    parameters: {
      path: { type: 'string', required: true, description: 'Exact design.path or selectedModel from the current meshState context.' },
      revision: { type: 'integer', required: true, description: 'Exact design.revision from the current meshState context.' },
      url: { type: 'string', required: true, description: 'Exact design.url from the current meshState context; identifies the loaded instance.' },
      label: { type: 'string', required: true, description: 'Short description of the proposed region, at most 200 characters. May be empty when clearing.' },
      regionName: { type: 'string', description: 'Optional short feature name shown on the mesh, in the person’s language, at most 64 characters. Name the exact highlighted feature using familiar, precise words. Omit when unsure or highlighting an unnamed patch. Use a unique meshPath for a named region so later references retain their original geometry.' },
      meshPath: { type: 'string', required: true, description: 'Project-relative STL containing the exact surface triangles to color. Empty string clears the overlay.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      if (!record?.source) return JSON.stringify({ status: 'model_required', message: 'Load an editable model with viewer_load first.' })
      focus.assertSelected(exec.agent, record.selectedModel)
      const started = performance.now()
      const operation = (async () => {
        const { result, receipt } = await serialize(record, async () => {
          exec.signal.throwIfAborted()
          await record.source.poll()
          exec.signal.throwIfAborted()
          if (typeof args.meshPath !== 'string') throw new Error('Supply a project-relative STL meshPath, or an empty string to clear')
          let bytes = null
          if (args.meshPath) {
            if (isAbsolute(args.meshPath) || extname(args.meshPath).toLowerCase() !== '.stl') throw new Error('Supply a project-relative STL meshPath')
            const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
            const target = await realpath(resolve(cwd, args.meshPath))
            const part = relative(await realpath(cwd), target)
            if (part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('Highlight mesh must be inside this project')
            const file = await ctx.fs.resolve(target, { cwd, signal: exec.signal })
            bytes = encodeStl(parseStl(await ctx.fs.readBytes(file, exec.signal, STL_LIMITS.maxBytes)))
            exec.signal.throwIfAborted()
          }
          const source = displaySource(record)
          const path = args.path === record.selectedModel ? source?.state().path : args.path
          const result = source?.highlight({ ...args, path, triangleCount: bytes ? (bytes.byteLength - 84) / 50 : 0 }) ?? { status: 'awaiting_validation', message: 'No accepted model is displayed yet.' }
          let receipt = null
          if (result.status === 'queued') {
            record.highlightMesh = { id: result.highlight.id, bytes }
            receipt = receipts.wait(exec.agent.session.id, result.highlight.id, exec.signal)
            diagnostics.record(exec.agent.session.id, 'highlight.requested', { highlightId: result.highlight.id, revision: args.revision, triangleCount: result.highlight.triangleCount })
          }
          if (result.status === 'cleared') record.highlightMesh = null
          events.notify(exec.agent.session.id)
          return { result, receipt }
        })
        if (!receipt) return JSON.stringify(result)
        const outcome = await receipt
        const status = ['viewer_hidden', 'render_failed', 'print_layout', 'highlight_hidden'].includes(outcome) ? 'not_rendered' : outcome
        const reason = outcome === 'not_rendered' ? 'ack_timeout' : outcome
        diagnostics.record(exec.agent.session.id, 'highlight.settled', { highlightId: result.highlight.id, status, reason, elapsedMs: Math.round(performance.now() - started) })
        exec.signal.throwIfAborted()
        return JSON.stringify({ ...result, status, reason, elapsedMs: Math.round(performance.now() - started), message: status === 'rendered'
          ? 'The visible viewer rendered this teal highlight. Use it as the visual reference for the requested change.'
          : reason === 'viewer_hidden' ? 'The viewer reports its document is hidden. Bring Rumi to the foreground and retry the highlight.'
          : reason === 'print_layout' ? 'Leave the print layout to show this highlight in the 3D preview.'
          : reason === 'highlight_hidden' ? 'Turn on highlight visibility in the preview to show this overlay.'
          : reason === 'render_failed' ? 'The viewer reported a rendering error. Read the current meshState context for the error before retrying.'
          : 'No matching rendering acknowledgment arrived. Visibility is unknown; do not claim the highlight is visible or absent. Ask the person to open the preview and retry.' })
      })()
      captureJobs.add(operation)
      try { return await operation }
      finally { captureJobs.delete(operation) }
    },
  })), 'print viewer: highlight region')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/shape-feedback`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      try {
        const value = await request.json(), record = sessions.get(sessionId)
        if (!record?.source?.shapeFeedback(value)) return json({ error: 'stale_controls' }, 409)
        const receiptId = record.source.state().analog.freezeRequested ? `${value.id}:freeze` : value.id
        if (value.status === 'viewer_hidden' || value.status === 'render_failed') receipts.fail(sessionId, receiptId, value.status)
        else if (value.status === 'rendered' || value.status === 'frozen') receipts.acknowledge(sessionId, value.status === 'frozen' ? `${value.id}:freeze` : value.id)
        if (value.status !== 'adjusted') events.notify(sessionId)
        diagnostics.record(sessionId, 'shape.feedback', { id: value.id, status: value.status, error: value.error, values: value.values, metrics: value.metrics })
        return json({ ok: true })
      } catch (_error) { return json({ error: 'invalid_shape_feedback' }, 400) }
    },
  }), 'print viewer: shape feedback')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/control-evidence`, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      const record = sessions.get(sessionId)
      try {
        const value = await request.json()
        await record?.source?.poll({ force: true })
        if (!record?.source?.controlReview.deliver(value.id, value.result)) return json({ error: 'stale_control_evidence' }, 409)
        events.notify(sessionId)
        return json({ ok: true })
      } catch (error) { return json({ error: String(error.message ?? error) }, 400) }
    },
  }), 'print viewer: control comparison evidence')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_controls',
    description: 'Prepare, validate, review, and present temporary mesh edit controls. prepare (or open) stages controls without showing them and requires an expected effect and preserved features for every axis. validate generates actual-mesh before/after and displacement-overlay images for endpoints and combinations. Inspect every image, then review each axis and combined effects using the evidenceId; accept only useful, well-behaved edits, otherwise revise and prepare again. present requires accepted current evidence. Changes to the model, fields, parts or ranges require new validation. Pending work is reminded in context. Freeze the latest visible values before saving in Blender; close cancels. Read mesh-edit-controls for intent and quality guidance. Persistent joint controls are authored in USD, independently of this workflow.',
    parameters: {
      action: { type: 'string', required: true, enum: ['prepare', 'open', 'validate', 'review', 'present', 'freeze', 'save', 'close'] },
      id: { type: 'string', description: 'Prepared control review id for validate/review/present, or active analog id for freeze/close.' },
      evidenceId: { type: 'string', description: 'Exact evidenceId returned by validation; required for review.' },
      expectations: { type: 'array', description: 'Required for prepare: expected geometric effect and features to preserve for every axis.', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', required: true }, effect: { type: 'string', required: true }, preserve: { type: 'string', required: true } } } },
      assessments: { type: 'array', description: 'Required for review: observations from the images and measurements, for every axis.', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', required: true }, decision: { type: 'string', enum: ['accept', 'revise'], required: true }, observation: { type: 'string', required: true } } } },
      combined: { type: 'object', description: 'Required for review: assessment of combined extremes.', additionalProperties: false, properties: { decision: { type: 'string', enum: ['accept', 'revise'], required: true }, observation: { type: 'string', required: true } } },
      path: { type: 'string', description: 'Current design.path for open, absolute or project-relative.' },
      revision: { type: 'integer', description: 'Exact design.revision for open.' },
      url: { type: 'string', description: 'Exact design.url for open.' },
      label: { type: 'string', description: 'Short plain-language region label.' },
      operation: { type: 'string', enum: ['surface', 'fields', 'parameters', 'bulge', 'bend', 'twist', 'taper', 'cut'], description: 'surface supports connected side-view profiles, radial bands, grooves, and explicit planar patches. fields blends displacement lattices. Other adapters are fixed USD edits. JavaScript parameters are disabled.' },
      form: { type: 'object', additionalProperties: true, description: 'For surface: profile {kind:"profile", at:[t,...], pinned?:[stationIndex,...], links?:{stationIndex:earlierStationIndex}, directions?:[[front,up],...], lateral?} binds p0,p1,... for unpinned stations; pinned stations stay at zero and have no control. Linked stations share the earlier station control and do not get a separate value. directions supplies unit vectors in the side-view plane; defaults point outward at each station. Equal linked directions create a rigid section. Values are travel in mm to 2–8 rising stations: t=.25 front mid-height, .5 crown, .75 back mid-height. Station displacements blend smoothly across the outline, including Z; the underside seam at 0/1 is pinned. lateral is 1–8, default 1. ring {kind:"ring",from,to,millimetres} binds amount. channel {kind:"channel",at:[degrees],from,to,widthMillimetres} binds depth in mm; width is arc length. facet {kind:"facet",from,to,planes:[{normal:[x,y,z],offset}],wallThickness?} binds amount in 0..1. Planes use unit outward normals and offsets in model mm; 1–12 planes must be opposing or perpendicular. At amount=1, points beyond each plane project onto it inside the band core. For oriented hollow shells, wallThickness in mm offsets inward-facing surfaces onto separate inner planes; ambiguous rim edges are rejected. Without it, only shallow patches or solid parts are suitable. from/to are normalized selection height, with edge fade .01–.5 (default .08). Every axis requires a control with reset 0 and range within ±1000. Verify thickness and fit; these mappings do not certify them.' },
      uAt: { type: 'number', description: 'For surface: front direction around model Z in degrees, default -90 (-Y). All selected parts share one bounds-derived frame.' },
      finish: { type: 'string', enum: ['parameters', 'blender'], description: 'For parameter controls: parameters saves a final JavaScript model; blender finishes a temporary preview on a preserved original.' },
      original: { type: 'string', description: 'Preserved source path for a Blender-finished preview.' },
      edit: { type: 'string', description: 'Semantic Blender edit recipe, including how parameter values affect the original and what must be preserved.' },
      fieldsPath: { type: 'string', description: 'Project-local JSON file containing the fields array; use instead of inline fields for generated lattices.' },
      fields: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'For operation fields: {key, origin:[x,y,z], spacing:[x,y,z], dimensions:[nx,ny,nz], offsets:[dx,dy,dz,...]}. Model-local mm; x fastest. 2–16 samples per axis, zero boundary offsets, at most 12 fields. Values/ranges within -1..1, reset 0. Read mesh-edit-controls.' },
      center: { type: 'array', items: { type: 'number' }, description: 'Three model-local coordinates, mm.' },
      radii: { type: 'array', items: { type: 'number' }, description: 'Three positive extents along U,V,N, mm; for cut these bound the allowed limit, not the plane footprint.' },
      direction: { type: 'array', items: { type: 'number' }, description: 'Three numbers: outward axis. Back of helmet is often [0,1,0]; inspect source.' },
      limit: { type: 'number', description: 'Maximum bulge displacement or cut-height travel either side of center, mm, no larger than the smallest radius.' },
      parts: { type: 'array', items: { type: 'string' }, description: 'Exact mesh names to deform; [] includes all meshes in the soft region.' },
      values: { type: 'object', additionalProperties: true, description: 'Numeric initial values keyed by model parameter name. USD adapters use amount, spread, peakX, peakY, falloff, angle in 0..1.' },
      controls: { type: 'array', description: 'Labeled controls. Supply for open. Each axis key binds a value; pad axes are horizontal then vertical.', items: {
        type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true, enum: ['slider', 'pad', 'curve'] },
          label: { type: 'string', required: true, description: 'Short label in the user’s language, such as Eye tilt.' },
          axes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            key: { type: 'string', required: true },
            ...Object.fromEntries(['min', 'max', 'step', 'reset'].map(key => [key, { type: 'number', required: true }])),
          } } },
        },
      } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => {
      const result = JSON.parse(value)
      return [{ type: 'text', text: value }, ...(result.images ?? []).map(image => ({ type: 'image', attachment: image }))]
    } },
    presentCall: args => ({ card: 'generic', title: args.action === 'open' ? 'Shape controls' : 'Update shape controls', kind: 'write' }),
    isConcurrencySafe: () => false, timeoutMs: (validationConfig?.validationTimeoutMs ?? loadTimeoutMs) * 2 + 15_000,
    async execute(args, exec) {
      const sessionId = exec.agent.session.id, record = sessions.get(sessionId)
      if (!record?.source) throw new Error('Load a model first')
      if (args.action === 'prepare') args = { ...args, action: 'open' }
      if (args.action === 'open' && !args.controls) throw new Error('Declare the labeled controls and their bindings before opening')
      focus.assertSelected(exec.agent, record.selectedModel)
      if (args.action === 'close') { if (record.source.controlReview.state()?.id === args.id) record.source.controlReview.clear(args.id); else record.source.clearShape(args.id); events.notify(sessionId); return JSON.stringify({ status: 'closed' }) }
      const operation = (async () => {
        const identity = () => { const state = record.source.state(); return { path: state.path, revision: state.revision, url: state.url, contentHash: state.contentHash } }
        await record.source.poll({ force: true })
        if (args.action === 'validate') {
          const release = record.source.retainSnapshot()
          try {
            const geometryRequest = record.source.controlReview.geometryRequest(args.id)
            if (geometryRequest) {
              if (!validationConfig) throw new Error('Control geometry validation requires the bundled Blender configuration')
              const geometry = await checkControlGeometry(validationConfig, record.source.snapshotBytes(), geometryRequest, exec.signal)
              await record.source.poll({ force: true })
              const checked = record.source.controlReview.geometry(args.id, geometry)
              if (checked.status === 'needs_revision') {
                events.notify(sessionId)
                return JSON.stringify({ ...checked, message: 'New intersecting triangle pairs block presentation. Existing defects nearby do not excuse new pairs. Protect the region, revise the deformation or range, or repair the source; then prepare and validate again.' })
              }
            }
            const work = record.source.controlReview.validate(args.id, exec.signal, validationConfig?.validationTimeoutMs ?? loadTimeoutMs)
            events.notify(sessionId)
            const result = await work
            exec.signal.throwIfAborted()
            if (result.status !== 'complete') throw new Error(result.message ?? 'Control validation was cancelled')
            const images = [], report = []
            for (const item of result.cases) {
              const { image, ...measurements } = item
              const attachment = await ctx.attachments.saveImage({ data: Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'), mediaType: 'image/png', name: `${item.id}.png` })
              images.push(attachment); report.push({ ...measurements, image: attachment })
            }
            await record.source.poll({ force: true })
            exec.signal.throwIfAborted()
            const review = record.source.controlReview.evidence(args.id, report)
            events.notify(sessionId)
            return JSON.stringify({ ...review, images, message: 'Inspect all attached comparisons. Record an assessment for every axis and the combined extremes before presenting.' })
          } catch (error) { record.source.controlReview.fail(args.id); throw error }
          finally { await release() }
        }
        if (args.action === 'review') {
          const review = record.source.controlReview.review(args.id, args.evidenceId, args.assessments, args.combined)
          events.notify(sessionId); return JSON.stringify(review)
        }
        if (args.action === 'save') return serialize(record, async () => {
          await record.source.poll()
          const saved = await record.source.saveParameters(args.id)
          events.notify(sessionId)
          return JSON.stringify({ status: 'saved', ...saved })
        })
        const preparedOrActive = await serialize(record, async () => {
          await record.source.poll()
          if (args.action === 'freeze') record.source.requestShapeFreeze(args.id)
          let fields = args.fields
          if (args.action === 'open' && args.fieldsPath !== undefined) {
            if (args.operation !== 'fields' || fields !== undefined) throw new Error('Use fieldsPath only for fields, without inline fields')
            const target = await realpath(resolve(record.cwd, args.fieldsPath)), part = relative(await realpath(record.cwd), target)
            if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Field data must stay inside the project')
            const bytes = await readFile(target)
            if (bytes.length > 2 * 1024 * 1024) throw new Error('Field data exceeds 2 MiB')
            fields = JSON.parse(bytes.toString('utf8'))
          }
          let original = args.original, originalHash, finish = args.finish, edit = args.edit
          if (args.action === 'open' && args.operation === 'parameters') {
            const marker = resolve(dirname(await realpath(resolve(record.cwd, args.path))), '.rumi-preview.json')
            let metadata
            try {
              const target = await realpath(marker), part = relative(await realpath(record.cwd), target)
              if (!part || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Preview marker must stay inside the project')
              const bytes = await readFile(target)
              if (bytes.length > 8192) throw new Error('Preview marker exceeds 8192 bytes')
              metadata = JSON.parse(bytes.toString('utf8'))
            } catch (error) { if (error.code !== 'ENOENT') throw error }
            if (metadata !== undefined) {
              if (!metadata || typeof metadata.original !== 'string' || !metadata.original || typeof metadata.edit !== 'string' || !metadata.edit) throw new Error('Invalid .rumi-preview.json: provide original and edit')
              finish = 'blender'; original = metadata.original; edit = metadata.edit
            }
          }
          if (args.action === 'open' && finish === 'blender') {
            if (typeof original !== 'string' || !original) throw new Error('Provide the preserved original path')
            original = await realpath(resolve(record.cwd, original))
            const inside = relative(await realpath(record.cwd), original)
            if (!inside || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Preserved original must be a file inside the project')
            originalHash = createHash('sha256').update(await readFile(original)).digest('hex')
          }
          if (args.action === 'open') {
            const current = identity(), path = await realpath(resolve(record.cwd, args.path))
            if (path !== current.path || args.revision !== current.revision || args.url !== current.url || record.source.state().error) throw new Error('Model changed; read current meshState before preparing controls')
            const review = record.source.controlReview.prepare({ ...args, fields, finish, edit, original, originalHash }, current)
            events.notify(sessionId)
            return { prepared: review }
          }
          const shape = args.action === 'present'
            ? record.source.shape(record.source.controlReview.present(args.id, identity()))
            : record.source.state().analog
          if (!shape) throw new Error('No active controls; prepare, validate, review and present first')
          if (args.action === 'present') record.source.controlReview.clear(args.id)
          const receipt = receipts.wait(sessionId, args.action === 'freeze' ? `${shape.id}:freeze` : shape.id, exec.signal)
          events.notify(sessionId)
          return { shape, receipt }
        })
        if (preparedOrActive.prepared) return JSON.stringify(preparedOrActive.prepared)
        const { shape, receipt } = preparedOrActive
        const status = await receipt
        exec.signal.throwIfAborted()
        if (status !== 'rendered') return JSON.stringify({ status: 'not_rendered', reason: status, id: shape.id,
          error: record.source.state().analog?.id === shape.id ? record.source.state().analog.error ?? null : null,
          message: status === 'viewer_hidden' ? 'The viewer is hidden. Bring Rumi to the foreground; controls will render when visible. This does not mean the binding is unsupported.'
            : status === 'render_failed' ? 'The control preview failed. Correct the reported binding or model error before reopening controls.'
            : 'No rendering acknowledgment arrived. Check viewer visibility and errors before retrying; a timeout does not establish that parameter controls are unsupported.' })
        if (args.action === 'freeze') {
          await record.source.poll()
          const recipe = record.source.freezeShape(args.id)
          if (recipe.finish === 'blender' && createHash('sha256').update(await readFile(recipe.original)).digest('hex') !== recipe.originalHash) throw new Error('Preserved original changed; reopen controls with the correct source')
          const directory = resolve(record.cwd, 'artifacts', 'shape-controls')
          await mkdir(directory, { recursive: true })
          const inside = relative(await realpath(record.cwd), await realpath(directory))
          if (inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Recipe directory must stay inside the project')
          const recipePath = resolve(directory, `${recipe.id}.json`)
          await writeFile(recipePath, JSON.stringify(recipe, null, 2)+'\n', { mode: 0o600 })
          events.notify(sessionId)
          return modelContextJson({ status: 'frozen', recipePath, recipe })
        }
        return modelContextJson({ status: 'rendered', controls: record.source.state().analog })
      })()
      captureJobs.add(operation)
      try { return await operation } finally { captureJobs.delete(operation) }
    },
  })), 'print viewer: analog shape controls')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_camera',
    description: 'Frame the source model and orbit the viewer camera without changing the design or its printed orientation.',
    parameters: {
      azimuth: { type: 'number', required: true, description: 'Degrees around the Z axis; zero looks from the front (-Y).' },
      elevation: { type: 'number', required: true, description: 'Degrees above the plate, between -89 and 89.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 10_000,
    async execute(args, exec) {
      const record = sessions.get(exec.agent?.session.id)
      const source = record && displaySource(record)
      if (!source) throw new Error('Load a validated model with viewer_load first')
      if (!Number.isFinite(args.azimuth) || !Number.isFinite(args.elevation) || Math.abs(args.elevation) > 89) throw new Error('Camera angles must be finite; elevation must be between -89 and 89')
      source.camera(args)
      return JSON.stringify(source.state())
    },
  })), 'print viewer: camera')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_open',
    description: 'Open an STL into this conversation’s 3D preview and place it on the plate. Coordinates are millimetres, Z up. '
      + 'Opening the same file again places a second copy: the scene holds objects that share mesh geometry. '
      + 'Pass `buildVolume` when the scene is headed for a printer; fit checks then use it and the preview draws it as a plate. '
      + 'Every check is a measurement. None of them establish print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'STL path in the session workspace, or an absolute path.' },
      buildVolume: {
        type: 'object', additionalProperties: false,
        description: 'Printable volume in millimetres for this scene. Omit for a mesh that is only being looked at.',
        properties: {
          x: { type: 'number', required: true, description: 'Width in millimetres.' },
          y: { type: 'number', required: true, description: 'Depth in millimetres.' },
          z: { type: 'number', required: true, description: 'Height in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('mesh_open requires a file path')
      if (extname(args.path).toLowerCase() !== '.stl') throw new Error('mesh_open accepts an STL file')
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const source = await ctx.fs.readBytes(target, exec.signal, STL_LIMITS.maxBytes)
      const positions = parseStl(source)
      exec.signal.throwIfAborted()
      if (closed) throw new Error('Mesh preview is closed')
      const record = recordFor(agent.session.id)
      if (args.buildVolume !== undefined) {
        const volume = createHistory().apply({ type: 'setVolume', volume: args.buildVolume }).volume
        if (record.source) await saveSelection(cwd, record.selectedModel, volume)
        record.history.apply({ type: 'setVolume', volume })
        loads.update(agent.session.id, loadIdentity(record))
      }
      const datablockId = datablockFor(record, target.displayPath ?? args.path, positions, encodeStl(positions))
      const scene = record.history.apply({ type: 'addObject', datablockId, name: basename(args.path) })
      refresh(record, [scene.objects.at(-1).id])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: open mesh tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_transform',
    description: 'Place one object in the 3D preview: uniform scale, rotation in degrees about the object’s centre, and position in millimetres. '
      + 'Each part you pass replaces that part and the rest is kept, so a scale stays when you only rotate. '
      + 'This never rewrites the mesh or the file; the scene holds the placement until it is baked for printing. '
      + 'Omit `objectId` when the scene holds exactly one object.',
    parameters: {
      objectId: { type: 'string', description: 'Object to place; defaults to the only object in the scene.' },
      scale: { type: 'number', description: 'Uniform scale greater than zero.' },
      rotate: {
        type: 'object', additionalProperties: false,
        description: 'Rotation in degrees about each axis, applied X then Y then Z, around the object’s centre.',
        properties: {
          x: { type: 'number', description: 'Rotation about X in degrees.' },
          y: { type: 'number', description: 'Rotation about Y in degrees.' },
          z: { type: 'number', description: 'Rotation about Z in degrees.' },
        },
      },
      position: {
        type: 'object', additionalProperties: false,
        description: 'Offset in millimetres on each axis, replacing the current offset.',
        properties: {
          x: { type: 'number', description: 'X offset in millimetres.' },
          y: { type: 'number', description: 'Y offset in millimetres.' },
          z: { type: 'number', description: 'Z offset in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_transform')
      record.history.apply({ type: 'setTransform', objectId, scale: args.scale, rotate: args.rotate, position: args.position })
      refresh(record, [objectId])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: place mesh tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_remove',
    description: 'Remove one object from the 3D preview. The mesh geometry stays available to the session, so opening the file again does not read it twice.',
    parameters: {
      objectId: { type: 'string', description: 'Object to remove; defaults to the only object in the scene.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_remove')
      record.history.apply({ type: 'removeObject', objectId })
      refresh(record)
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: remove mesh tool')
}
