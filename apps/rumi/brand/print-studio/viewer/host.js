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
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { analyzeMesh } from './checks.js'
import { createHistory } from './document.js'
import { STL_LIMITS, encodeStl, parseStl } from './stl.js'
import { placeMesh } from './transform.js'

import { createViewerDiagnostics } from './diagnostics.js'
import { createHighlightReceipts } from './receipts.js'
import { createViewerEvents } from './events.js'
import { createCursorRequests, cursorIdentity } from './cursor.js'
import { cursorCommand } from './cursor-commands.js'
import { createModelFocus } from './model-focus.js'
import { createSource } from './source.js'
import { discoverModels, readSelection, saveSelection } from './catalog.js'

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
  return { status: errors > 0 ? 'blocked' : warnings > 0 ? 'review' : 'ok', errors, warnings }
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

/**
 * Register the preview routes and the scene tools.
 * @param {object} ctx - Cordis host context with connection, tools, fs, and workingDirectory.
 * @param {Function} defineTool - DSH's schema-validating tool factory from the host entrypoint.
 * @param {string} diagnosticsDirectory - Private local journal directory.
 * @returns {void}
 */
export function applyViewer(ctx, defineTool, diagnosticsDirectory) {
  const diagnostics = createViewerDiagnostics(diagnosticsDirectory)
  const sessions = new Map()
  const receipts = createHighlightReceipts()
  const events = createViewerEvents()
  const focus = createModelFocus(ctx, { read: id => sessions.get(id), notify: id => events.notify(id) })
  const cursors = createCursorRequests(sessionId => events.notify(sessionId))
  const captureJobs = new Set()
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:active-shape', order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'), interpolate: false,
      text: context => {
        const shape = sessions.get(context.agent?.session.id)?.source?.state().analog
        if (!shape) return ''
        return `Unresolved mesh edit: ${JSON.stringify({ id: shape.id, region: shape.label, operation: shape.operation, values: shape.values, frozen: shape.frozen })}. Read mesh_state. Keep this edit as the focus while tuning. If the person is satisfied or moves to another task, finish the current edit first: freeze, apply the captured recipe in Blender, publish and load it. If already frozen, complete that save. Explicit cancel/revert uses close instead. Verify both controls and highlight are cleared. Do not require a special phrase.`
      },
    }), 'print-studio active edit context')
  })
  let closed = false
  ctx.effect(() => async () => {
    closed = true
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
    const record = { history: createHistory(), datablocks: new Map(), byPath: new Map(), measurements: new Map(), pending: Promise.resolve() }
    sessions.set(sessionId, record)
    while (sessions.size > MAX_SESSIONS) {
      const key = [...sessions.keys()].find(id => id !== sessionId && !sessions.get(id).busy && focus.paths(id).length === 0)
      if (key === undefined) break
      const source = sessions.get(key).source
      if (source) ctx.effect(async () => { await source.dispose(); return () => {} }, 'print viewer: evict source')
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
    const source = await createSource(ctx, resolve(cwd, path), cwd)
    try {
      signal?.throwIfAborted()
      if (closed) throw new Error('Model preview is closed')
      const selected = relative(cwd, resolve(cwd, path)).split(sep).join('/')
      await saveSelection(cwd, selected, volume === undefined ? record.history.current().volume : volume)
      if (closed) throw new Error('Model preview is closed')
      await record.source?.dispose()
      record.source = source
      record.cwd = cwd
      record.selectedModel = selected
      record.catalogError = null
      if (volume !== undefined) {
        record.history.apply({ type: 'setVolume', volume })
        refresh(record)
      }
    } catch (error) {
      await source.dispose()
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
    record.catalogError = null
  }

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
    if (receipts.has(sessionId)) diagnostics.record(sessionId, 'viewer.state_delivered', { highlightId: record.source?.state().highlight?.id ?? null })
    return json({ cursorRequest: cursors.read(sessionId), scene: {
      ...sceneState(record), design: record.source?.state() ?? null,
      models: record.models ?? [], selectedModel: record.selectedModel ?? null,
      workingModels: focus.paths(sessionId),
      catalogFailed: Boolean(record.catalogError),
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
        return json({ ok: true })
      } catch (_error) { return json({ error: 'selection_failed' }, 409) }
    },
  }), 'print viewer: select model')

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
      const source = sessions.get(sessionId)?.source
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
      try { source.feedback(value) } catch (_error) { diagnostics.record(sessionId, 'viewer.feedback_rejected', { reason: 'invalid_report' }); return json({ error: 'invalid_feedback' }, 400) }
      const current = source.state()
      if (value.highlightId && value.highlightId === current.highlight?.id
        && value.revision === current.revision && value.url === current.url
        && JSON.stringify(value.transform) === JSON.stringify(current.transform)) {
        diagnostics.record(sessionId, 'highlight.acknowledged', { highlightId: value.highlightId })
        receipts.acknowledge(sessionId, value.highlightId)
      }
      if (value.requestedHighlightId === current.highlight?.id
        && value.revision === current.revision && value.url === current.url
        && JSON.stringify(value.transform) === JSON.stringify(current.transform)
        && ['viewer_hidden', 'render_failed'].includes(value.highlightStatus)) {
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
          const snapshot = record.source?.state().error ? { status: 'stale_view' } : value.snapshot
          const accepted = cursors.deliver(sessionId, value.requestId, snapshot, cursorIdentity(record))
          return json({ accepted }, accepted ? 200 : 409)
        } catch (_error) { return json({ error: 'invalid_snapshot' }, 400) }
      })
    },
  }), 'print viewer: cursor response')

  ctx.inject(['liveVoice'], scoped => {
    scoped.effect(() => scoped.liveVoice.register({
      id: 'print-studio-pointing',
      instructions: () => 'Cursor driven mesh highlighting responds directly to short selection phrases: local patch, whole panel, whole part, just the edge, larger selection, smaller selection. These refine a visual reference only; they never edit geometry. Still delegate the request. Use the attached refined reference and have the modeling assistant confirm it in teal with viewer_highlight, copying region.selection and modelLocalBlob. Do not claim a preview succeeded without its result. When mesh shaping controls are active, delegate satisfaction, completion, cancellation, and changes of topic so the modeling assistant can resolve the current edit and clear its controls and highlight before proceeding. Do not merely acknowledge that it is done.',
      refineRequest: async ({ sessionId, text, content, signal }) => {
        const command = cursorCommand(text)
        if (!command) return content
        const referenceIndex = content.findIndex(part => part.type === 'text' && part.text.startsWith('{"reference":"cursor-at-start-of-spoken-request"'))
        if (referenceIndex < 0) return content
        const reference = JSON.parse(content[referenceIndex].text)
        if (reference.command === command || reference.snapshot?.status !== 'captured' || !reference.snapshot.region.anchorId) return content
        const { image, ...snapshot } = JSON.parse(await captureReference(sessionId, signal, { command, anchorId: reference.snapshot.region.anchorId }))
        return content.flatMap((part, index) => {
          if (index === referenceIndex) return [{ type: 'text', text: JSON.stringify({ ...reference, command, snapshot }) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
          if (index === referenceIndex + 1 && part.type === 'image') return []
          return [part]
        })
      },
      captureRequest: async ({ sessionId, requestedAt, signal }) => {
        if (!sessions.has(sessionId)) return []
        const record = sessions.get(sessionId)
        const selectionAtSpeech = { path: record.selectedModel ?? null, revision: record.source?.state().revision ?? null }
        const { image, ...snapshot } = JSON.parse(await captureReference(sessionId, signal))
        return [{ type: 'text', text: JSON.stringify({
          reference: 'cursor-at-start-of-spoken-request', requestedAt, selectionAtSpeech, snapshot,
          instruction: 'Use this reference for pointing in this request, not a later live cursor position. Highlight the intended area to establish a visual reference. Follow the user’s requested action; ask for clarification when their intent is ambiguous.',
        }) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
      },
    }), 'print viewer: spoken pointing references')
  })

  async function captureReference(sessionId, signal, refinement = {}) {
    if (closed) return JSON.stringify({ status: 'viewer_unavailable' })
    const capture = (async () => {
        const record = sessions.get(sessionId)
        if (!record) return JSON.stringify({ status: 'viewer_unavailable' })
        const identity = await serialize(record, async () => { await record.source?.poll(); return cursorIdentity(record) })
        if (record.source?.state().error) return JSON.stringify({ status: 'stale_view' })
        const snapshot = await cursors.request(sessionId, identity, signal, refinement)
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
    description: 'Ask the open 3D viewer to capture the current cursor Gaussian region and a PNG of the current view. Cursor mesh vision is blue; agent viewer_highlight regions are teal. Captures when the viewer services this request, not when the person last spoke. Prefer an attached cursor-at-start-of-spoken-request reference for that utterance. Returns a revision-specific region.selection (surface/part/edge scope) and anchorId; copy selection together with modelLocalBlob into viewer_highlight to confirm the exact area. Returns the pointed object/part, world-space point and radius in millimetres, model identity, camera and capture time. Editable-model hits include modelLocalBlob ready for viewer_highlight with identity.design path/revision/url. Read the image and region before highlighting or editing. no_hit means no active cursor intersection; viewer_unavailable means no response from an open viewer. Never substitute an earlier hover or treat a soft region as an exact edit mask.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => {
      const { image, ...snapshot } = JSON.parse(value)
      return [{ type: 'text', text: JSON.stringify(snapshot) }, ...(image ? [{ type: 'image', attachment: image }] : [])]
    } },
    presentCall: () => ({ card: 'generic', title: 'Inspect cursor region', kind: 'read' }),
    isConcurrencySafe: () => true, timeoutMs: 10_000,
    async execute(_args, exec) {
      if (closed) return JSON.stringify({ status: 'viewer_unavailable' })
      return captureReference(exec.agent?.session.id, exec.signal)
    },
  })), 'print viewer: inspect cursor')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_working_model',
    description: 'Declare which existing model you are actively inspecting or editing. Shows a green dot without changing the user selection. Use a path from mesh_state.models; call before work and when changing targets. Omit path to clear before clarification or unrelated work. The host also clears it when your agent stops or is disposed. This declaration does not authorize edits or resolve ambiguous references.',
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
        if (!record.models.some(model => model.path === path)) throw new Error('Model entry not found; read mesh_state')
      }
      exec.signal.throwIfAborted()
      if (closed) throw new Error('Model preview is closed')
      focus.set(exec.agent, path)
      return JSON.stringify({ workingModel: path, selectedModel: record.selectedModel ?? null })
    },
  })), 'print viewer: declare working model')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_load',
    description: 'Select a Blender-exported GLB in the Three.js viewer. Use models/<name>/model.glb; the viewer discovers these entries and reloads completed exports automatically. '
      + 'GLB uses standard metres and Y up; the viewer converts to millimetres and Z up for measurements, placement and Gaussian regions. '
      + 'Use blender_status and the blender-modeling skill for editing with background Blender scripts. Keep .blend originals and revision exports. '
      + 'Self-contained static GLB only, at most 64 MiB and 200,000 preview triangles. Preserve detailed originals when making a lighter preview. '
      + 'Legacy .js/.mjs entries exporting synchronous build(THREE) remain supported in millimetres and Z up. '
      + 'Read mesh_state for load errors and measurements. Loading does not certify print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'Model entry to bring into view, for example models/helmet/model.glb.' },
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
      const record = recordFor(exec.agent.session.id)
      const disposeLoad = ctx.effect(async () => {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        exec.signal.throwIfAborted()
        if (closed) throw new Error('Model preview is closed')
        await serialize(record, () => loadSource(record, cwd, args.path, volume, exec.signal))
        return () => {}
      }, 'print viewer: load model')
      await disposeLoad
      if (closed) throw new Error('Model preview is closed')
      record.models = await discoverModels(record.cwd)
      return JSON.stringify(sceneReport(record), undefined, 2)
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
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print viewer: source placement')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_highlight',
    description: 'Replace temporary Gaussian wireframe regions on the editable model loaded by viewer_load. Read mesh_state for design.path, revision and url; inspect model source to locate regions. Coordinates are model-local millimetres before viewer_transform, including part transforms. Rotation uses XYZ Euler degrees. Up to eight ellipsoids combine by maximum influence, with a fixed soft fade. All intersected surfaces, including the back, may be highlighted. Empty blobs clears. Does not edit geometry or exports. Waits for the visible viewer to acknowledge the matching highlight. Returns rendered only after acknowledgment; not_rendered or superseded is not success. Rendering is not user confirmation. Use this tool to visually ground region-specific edits and explanations of named parts. Follow the user’s requested action and clarify ambiguous intent; no special confirmation phrase is required. Use clarify-mesh-changes for guidance.',
    parameters: {
      path: { type: 'string', required: true, description: 'Exact design.path from mesh_state.' },
      revision: { type: 'integer', required: true, description: 'Exact design.revision from mesh_state.' },
      url: { type: 'string', required: true, description: 'Exact design.url from mesh_state; identifies the loaded instance.' },
      label: { type: 'string', required: true, description: 'Short description of the proposed region, at most 200 characters. May be empty when clearing.' },
      selection: { type: 'object', additionalProperties: false, description: 'Optional exact surface restriction from cursor region.selection. Copy with modelLocalBlob to visually confirm cursor driven mesh highlighting.', properties: {
        partPath: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact hierarchy path from region.selection.' },
        surfaceId: { type: 'integer', required: true, description: 'Exact surfaceId from region.selection for this revision.' },
        mode: { type: 'string', required: true, enum: ['patch', 'surface', 'part', 'edge'], description: 'Local patch, connected surface, whole mesh part, or nearby boundary edge.' },
      } },
      blobs: { type: 'array', required: true, description: 'Zero to eight ellipsoids; an empty array clears the highlight.', items: {
        type: 'object', additionalProperties: false, properties: {
          center: { type: 'array', required: true, items: { type: 'number' }, description: 'Exactly three coordinates [x,y,z] in millimetres.' },
          radii: { type: 'array', required: true, items: { type: 'number' }, description: 'Exactly three positive nominal extents [x,y,z] in millimetres, at least 0.001. Influence is exp(-1.5 * squared normalized distance), fading out near 1.3 times these extents.' },
          rotationDegrees: { type: 'array', required: true, items: { type: 'number' }, description: 'Exactly three XYZ Euler angles in degrees; [0,0,0] aligns with model axes.' },
        },
      } },
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
          const result = record.source.highlight(args)
          let receipt = null
          if (result.status === 'queued') {
            receipt = receipts.wait(exec.agent.session.id, result.highlight.id, exec.signal)
            diagnostics.record(exec.agent.session.id, 'highlight.requested', { highlightId: result.highlight.id, revision: args.revision, blobCount: args.blobs.length })
          }
          events.notify(exec.agent.session.id)
          return { result, receipt }
        })
        if (!receipt) return JSON.stringify(result)
        const outcome = await receipt
        const status = ['viewer_hidden', 'render_failed'].includes(outcome) ? 'not_rendered' : outcome
        const reason = outcome === 'not_rendered' ? 'ack_timeout' : outcome
        diagnostics.record(exec.agent.session.id, 'highlight.settled', { highlightId: result.highlight.id, status, reason, elapsedMs: Math.round(performance.now() - started) })
        exec.signal.throwIfAborted()
        return JSON.stringify({ ...result, status, reason, elapsedMs: Math.round(performance.now() - started), message: status === 'rendered'
          ? 'The visible viewer rendered this teal highlight. Use it as the visual reference for the requested change.'
          : reason === 'viewer_hidden' ? 'The viewer reports its document is hidden. Bring Rumi to the foreground and retry the highlight.'
          : reason === 'render_failed' ? 'The viewer reported a rendering error. Read mesh_state for the error before retrying.'
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
        receipts.acknowledge(sessionId, value.status === 'frozen' ? `${value.id}:freeze` : value.id)
        if (value.status === 'frozen') events.notify(sessionId)
        diagnostics.record(sessionId, 'shape.feedback', { id: value.id, status: value.status, values: value.values, metrics: value.metrics })
        return json({ ok: true })
      } catch (_error) { return json({ error: 'invalid_shape_feedback' }, 400) }
    },
  }), 'print viewer: shape feedback')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_shape_controls',
    description: 'Give the person continuous analog controls over a real local deformation: bulge, bend, twist, taper, or a continuous planar cut. Read mesh_state. For deformations, visually highlight the region first. Cut mode supplies its own continuous teal cut-line guide; do not assemble Gaussian blobs around a cut. Open uses a model-local millimetre ellipsoid in a frame whose N axis is direction, U is across, V is up. Strength, spread, tilt, peak position, and falloff respond locally without agent calls. parts contains exact mesh names, or [] for all intersecting meshes. For cut, direction points toward the retained side (bottom trim: [0,0,1]); center is the neutral plane point, amount shifts height by +/-limit mm, angle tilts along V and spread leans along U by +/-60 degrees. At .5/.5 both angles are neutral; peak and falloff are unused. The plane crosses all selected parts, without an ellipsoid boundary. Preview caps are visual; Blender performs the real capped cut on finish. Extrusion, curved cuts, and bevel are not supported by these controls. For the helmet back prefer bulge. Do not overwrite the original while tuning. When the person is satisfied or moves on, freeze captures the latest controls from the visible viewer and writes a recipe; use blender_status and the helper apply_shape_controls(recipePath) on the original .blend, publish a new revision, then viewer_load. Close discards the local edit. Read analog-shaping for the workflow. Only rendered confirms the controls and operation guide are displayed.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'freeze', 'close'] },
      id: { type: 'string', description: 'Current design.analog.id for freeze or close.' },
      path: { type: 'string', description: 'Exact design.path for open.' },
      revision: { type: 'integer', description: 'Exact design.revision for open.' },
      url: { type: 'string', description: 'Exact design.url for open.' },
      label: { type: 'string', description: 'Short plain-language region label.' },
      operation: { type: 'string', enum: ['bulge', 'bend', 'twist', 'taper', 'cut'] },
      center: { type: 'array', items: { type: 'number' }, description: 'Three model-local coordinates, mm.' },
      radii: { type: 'array', items: { type: 'number' }, description: 'Three positive extents along U,V,N, mm; for cut these bound the allowed limit, not the plane footprint.' },
      direction: { type: 'array', items: { type: 'number' }, description: 'Three numbers: outward axis. Back of helmet is often [0,1,0]; inspect source.' },
      limit: { type: 'number', description: 'Maximum bulge displacement or cut-height travel either side of center, mm, no larger than the smallest radius.' },
      parts: { type: 'array', items: { type: 'string' }, description: 'Exact mesh names to deform; [] includes all meshes in the soft region.' },
      values: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['amount','spread','peakX','peakY','falloff','angle'].map(key => [key, { type: 'number', required: true, description: 'Normalized 0..1. Neutral amount .5, spread .5, peak .5/.5, tilt angle .5. Positive bulge amount > .5.' }])) },
    },
    output: { schema: { type: 'string' }, render: (_args,value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', title: args.action === 'open' ? 'Shape controls' : 'Update shape controls', kind: 'write' }),
    isConcurrencySafe: () => false, timeoutMs: 15_000,
    async execute(args, exec) {
      const sessionId = exec.agent.session.id, record = sessions.get(sessionId)
      if (!record?.source) throw new Error('Load a GLB model first')
      focus.assertSelected(exec.agent, record.selectedModel)
      if (args.action === 'close') { record.source.clearShape(args.id); events.notify(sessionId); return JSON.stringify({ status: 'closed' }) }
      const operation = (async () => {
        const { shape, receipt } = await serialize(record, async () => {
          await record.source.poll()
          if (args.action === 'freeze') record.source.requestShapeFreeze(args.id)
          const shape = args.action === 'open' ? record.source.shape(args) : record.source.state().analog
          const receipt = receipts.wait(sessionId, args.action === 'freeze' ? `${shape.id}:freeze` : shape.id, exec.signal)
          events.notify(sessionId)
          return { shape, receipt }
        })
        const status = await receipt
        exec.signal.throwIfAborted()
        if (status !== 'rendered') return JSON.stringify({ status: 'not_rendered', reason: status, id: shape.id })
        if (args.action === 'freeze') {
          await record.source.poll()
          const recipe = record.source.freezeShape(args.id)
          const directory = resolve(record.cwd, 'artifacts', 'shape-controls')
          await mkdir(directory, { recursive: true })
          const inside = relative(await realpath(record.cwd), await realpath(directory))
          if (inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Recipe directory must stay inside the project')
          const recipePath = resolve(directory, `${recipe.id}.json`)
          await writeFile(recipePath, JSON.stringify(recipe, null, 2)+'\n', { mode: 0o600 })
          events.notify(sessionId)
          return JSON.stringify({ status: 'frozen', recipePath, recipe })
        }
        return JSON.stringify({ status: 'rendered', controls: record.source.state().analog })
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
      const source = sessions.get(exec.agent?.session.id)?.source
      if (!source) throw new Error('Load a model with viewer_load first')
      if (!Number.isFinite(args.azimuth) || !Number.isFinite(args.elevation) || Math.abs(args.elevation) > 89) throw new Error('Camera angles must be finite; elevation must be between -89 and 89')
      source.camera(args)
      return JSON.stringify(source.state())
    },
  })), 'print viewer: camera')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_state',
    description: 'Read the 3D preview scene without changing it: every object, its placement, and the measurements of its composed mesh. '
      + 'Includes discovered models and the selected model. Saved GLB and JavaScript models reload when the viewer opens; STL scene objects remain in memory. Read this tool instead of assuming what is on screen.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      record.models = await discoverModels(cwd)
      return JSON.stringify({ ...sceneReport(record), workingModels: focus.paths(agent.session.id) }, undefined, 2)
    },
  })), 'print-studio: read scene tool')

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
