/** HTTP endpoints for the 3D preview browser pane: state, long-poll events, meshes, feedback, and cursor/control RPCs. */
import { json } from '../http.js'
import { USD_MAX_BYTES } from './usd.js'
import { MAX_CURSOR_BODY_CHARS } from './cursor.js'
import { discoverModels } from './catalog.js'
import { HIGHLIGHT_FAILURES, loadIdentity, MESH_HEADERS, ROUTE, sceneReport, sceneState } from './host-state.js'

const TRACE_PHASES = new Set([
  'apply_started', 'apply_finished', 'feedback_started', 'feedback_failed',
  'feedback_delivered', 'apply_or_feedback_failed', 'effect_disposed',
])

/**
 * Register all `/api/print-studio/viewer/*` routes on the Cordis connection service.
 * @param {object} deps Shared viewer runtime collaborators.
 * @returns {void}
 */
export function registerViewerRoutes({
  ctx, store, diagnostics, receipts, loads, events, cursors, focus, activity, validation,
}) {
  const { sessions, displaySource, displayIdentity, recordFor, serialize, directoryFor, loadSource, discover } = store

  const register = (path, methods, fetch, label) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods, requestBody: 'buffered', fetch,
  }), label)

  register('/events', ['GET'], async request => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    const after = Number(url.searchParams.get('after'))
    if (!sessionId || !Number.isSafeInteger(after) || after < 0) return json({ error: 'invalid_event_cursor' }, 400)
    const event = await events.wait(sessionId, after, request.signal)
    if (receipts.has(sessionId)) diagnostics.record(sessionId, 'viewer.event_delivered', { version: event.version })
    return json(event)
  }, 'print-studio: preview /events')

  register('/state', ['GET'], async request => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId) return json({ error: 'session_required' }, 400)
    const record = recordFor(sessionId)
    await serialize(record, async () => {
      try { await discover(sessionId, record) }
      catch (error) { record.catalogError = String(error) }
    })
    if (receipts.has(sessionId)) diagnostics.record(sessionId, 'viewer.state_delivered', { highlightId: displaySource(record)?.state().highlight?.id ?? null })
    const displayed = sceneState(record)
    return json({
      controlValidationRequest: record.source?.controlReview.request() ?? null,
      validationRequests: validation?.requests(sessionId) ?? [],
      cursorRequest: cursors.read(sessionId),
      scene: {
        validation: validation?.read(sessionId),
        ...displayed,
        design: record.source?.state() ?? null,
        models: record.models ?? [],
        selectedModel: record.selectedModel ?? null,
        workingModels: focus.paths(sessionId),
        agentRunning: focus.running(sessionId),
        agentActivity: activity.read(sessionId),
        catalogFailed: Boolean(record.catalogError),
      },
    })
  }, 'print-studio: preview /state')

  register('/select', ['POST'], async request => {
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
  }, 'print viewer: select model')

  register('/validation', ['POST'], async request => {
    const url = new URL(request.url), id = url.searchParams.get('sessionId'), job = url.searchParams.get('id')
    if (!id || !job || !validation) return json({ error: 'validation_not_found' }, 404)
    try {
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > USD_MAX_BYTES) return json({ error: 'mesh_too_large' }, 413)
      const error = request.headers.get('content-type') === 'text/plain' ? new TextDecoder().decode(bytes) : null
      return validation.submit(id, job, bytes, error) ? json({ ok: true }) : json({ error: 'stale_validation' }, 409)
    } catch (_error) { return json({ error: 'invalid_validation_mesh' }, 400) }
  }, 'print viewer: validation geometry')

  register('/highlight-mesh', ['GET'], async request => {
    const query = new URL(request.url).searchParams
    const record = sessions.get(query.get('sessionId'))
    const mesh = record?.highlightMesh
    if (!mesh || mesh.id !== query.get('id') || displaySource(record)?.state().highlight?.id !== mesh.id) return json({ error: 'highlight_not_found' }, 404)
    return new Response(mesh.bytes.slice(0), { headers: MESH_HEADERS })
  }, 'print-studio: preview /highlight-mesh')

  register('/model', ['GET'], async request => {
    const query = new URL(request.url).searchParams
    const sessionId = query.get('sessionId')
    const datablock = sessionId === null ? undefined : sessions.get(sessionId)?.datablocks.get(query.get('datablockId'))
    if (datablock === undefined) return json({ error: 'preview_not_found' }, 404)
    return new Response(datablock.bytes.slice(0), { headers: MESH_HEADERS })
  }, 'print-studio: preview /model')

  register('/trace', ['POST'], async request => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessions.has(sessionId)) return json({ error: 'preview_not_found' }, 404)
    const body = await request.text()
    if (body.length > 2048) return json({ error: 'trace_too_large' }, 413)
    let value
    try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_trace' }, 400) }
    if (!value || typeof value.highlightId !== 'string' || value.highlightId.length > 128
      || !TRACE_PHASES.has(value.phase)
      || typeof value.hidden !== 'boolean'
      || !['receivedAt', 'elapsedMs', 'width', 'height'].every(key => Number.isFinite(value[key]) && value[key] >= 0)) {
      return json({ error: 'invalid_trace' }, 400)
    }
    diagnostics.record(sessionId, `client.${value.phase}`, {
      highlightId: value.highlightId, hidden: value.hidden, receivedAt: value.receivedAt,
      elapsedMs: value.elapsedMs, width: value.width, height: value.height,
    })
    return json({ ok: true })
  }, 'print viewer: client diagnostics')

  register('/feedback', ['POST'], async request => {
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
        client: value.diagnostics ? {
          hidden: value.diagnostics.hidden === true,
          elapsedMs: Number.isFinite(value.diagnostics.elapsedMs) ? value.diagnostics.elapsedMs : null,
          width: Number.isFinite(value.diagnostics.width) ? value.diagnostics.width : null,
          height: Number.isFinite(value.diagnostics.height) ? value.diagnostics.height : null,
        } : null,
        highlightStatus: value.highlightStatus ?? null,
        hasError: Boolean(value.error),
      })
    }
    if (value.renderRequest !== source.state().renderRequest) return json({ error: 'stale_render_feedback' }, 409)
    try {
      if (!source.feedback(value)) return json({ error: 'stale_render_feedback' }, 409)
    } catch (_error) { diagnostics.record(sessionId, 'viewer.feedback_rejected', { reason: 'invalid_report' }); return json({ error: 'invalid_feedback' }, 400) }
    const current = source.state()
    const record = sessions.get(sessionId)
    const matchesCurrent = value.revision === current.revision && value.url === current.url
      && JSON.stringify(value.transform) === JSON.stringify(current.transform)
    if (record?.source === source && matchesCurrent
      && JSON.stringify(value.volume) === JSON.stringify(record.history.current().volume)
      && value.renderRequest === current.renderRequest) {
      const status = current.error ? (current.error.kind === 'source' ? 'source_failed' : 'build_failed')
        : value.loadStatus === 'viewer_hidden' ? 'viewer_hidden'
        : value.loadStatus === 'ready' && current.report ? 'ready' : null
      if (status) loads.update(sessionId, loadIdentity(record), {
        status, scene: structuredClone(sceneReport(record)), ...(current.error ? { error: current.error } : {}),
      })
    }
    if (value.highlightId && value.highlightId === current.highlight?.id && matchesCurrent) {
      diagnostics.record(sessionId, 'highlight.acknowledged', { highlightId: value.highlightId })
      receipts.acknowledge(sessionId, value.highlightId)
    }
    if (value.requestedHighlightId === current.highlight?.id && matchesCurrent && HIGHLIGHT_FAILURES.has(value.highlightStatus)) {
      receipts.fail(sessionId, value.requestedHighlightId, value.highlightStatus)
    }
    return json({ ok: true })
  }, 'print viewer: build feedback')

  register('/cursor', ['POST'], async request => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    const record = sessions.get(sessionId)
    if (!record) return json({ error: 'preview_not_found' }, 404)
    const body = await request.text()
    if (body.length > MAX_CURSOR_BODY_CHARS) return json({ error: 'snapshot_too_large' }, 413)
    let value
    try { value = JSON.parse(body) } catch (_error) { return json({ error: 'invalid_snapshot' }, 400) }
    if (typeof value?.requestId !== 'string') return json({ error: 'invalid_snapshot' }, 400)
    return serialize(record, async () => {
      await record.source?.poll()
      try {
        const design = displaySource(record)?.state()
        const snapshot = design?.error ? { status: 'stale_view' } : value.snapshot
        const accepted = cursors.deliver(sessionId, value.requestId, snapshot, displayIdentity(record))
        return json({ accepted }, accepted ? 200 : 409)
      } catch (_error) { return json({ error: 'invalid_snapshot' }, 400) }
    })
  }, 'print viewer: cursor response')

  register('/shape-feedback', ['POST'], async request => {
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
  }, 'print viewer: shape feedback')

  register('/control-evidence', ['POST'], async request => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    const record = sessions.get(sessionId)
    try {
      const value = await request.json()
      await record?.source?.poll({ force: true })
      if (!record?.source?.controlReview.deliver(value.id, value.result)) return json({ error: 'stale_control_evidence' }, 409)
      events.notify(sessionId)
      return json({ ok: true })
    } catch (error) { return json({ error: String(error.message ?? error) }, 400) }
  }, 'print viewer: control comparison evidence')
}
