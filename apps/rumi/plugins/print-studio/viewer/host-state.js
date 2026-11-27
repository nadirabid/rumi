/** Session-scoped viewer scene records, geometry measurements, projections, and LRU lifecycle. */
import { basename, relative, resolve, sep } from 'node:path'
import { analyzeMesh } from './checks.js'
import { createHistory } from './document.js'
import { placeMesh } from './transform.js'
import { createSource } from './source.js'
import { discoverModels, readSelection, saveSelection } from './catalog.js'
import { cursorIdentity } from './cursor.js'

const MAX_SESSIONS = 8

export const ROUTE = '/api/print-studio/viewer'
/** A datablock never changes once opened, so its bytes stay cacheable for the page's lifetime. */
export const MESH_HEADERS = Object.freeze({
  'cache-control': 'private, max-age=3600, immutable',
  'content-type': 'application/octet-stream',
  'x-content-type-options': 'nosniff',
})
export const HIGHLIGHT_FAILURES = new Set(['viewer_hidden', 'render_failed', 'print_layout', 'highlight_hidden', 'region_unavailable'])

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Reuse an existing datablock for identical bytes at `path`, otherwise store a new one.
 * @param {object} record - Session record.
 * @param {string} path - Path the bytes were read from.
 * @param {Float32Array} positions - Parsed geometry.
 * @param {ArrayBuffer} bytes - Canonical encoding sent to the browser.
 * @returns {string} Datablock id.
 */
export function datablockFor(record, path, positions, bytes) {
  const existing = record.datablocks.get(record.byPath.get(path))
  if (existing !== undefined && sameBytes(existing.bytes, bytes)) return record.byPath.get(path)
  const id = crypto.randomUUID()
  record.datablocks.set(id, { name: basename(path), positions, bytes })
  record.byPath.set(path, id)
  return id
}

/** Return the single object id in `record` when a caller omits `objectId`. */
export function onlyObject(record, intent) {
  const { objects } = record.history.current()
  if (objects.length === 1) return objects[0].id
  throw new Error(`${intent} needs an objectId when the scene holds ${objects.length === 0 ? 'no objects' : `${objects.length} objects`}`)
}

function measureObject(record, object) {
  const datablock = record.datablocks.get(object.datablockId)
  const placed = placeMesh(datablock.positions, object.transform)
  return { matrix: placed.matrix, report: analyzeMesh(placed.positions, { volume: record.history.current().volume }) }
}

/** Re-measure modified objects and drop removed measurements. */
export function refreshMeasurements(record, objectIds) {
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

/** View state sent to the browser: placement matrices and statuses without full measurement reports. */
export function sceneState(record) {
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

export function designIdentity(design) {
  if (!design) return null
  return { path: design.path, revision: design.revision, url: design.url, contentHash: design.contentHash ?? null }
}

function agentDesign(design) {
  if (!design?.regionMap) return design ?? null
  const { key, regions, remainder } = design.regionMap
  return {
    ...design,
    regionMap: {
      key,
      remainder,
      regions: regions.map(({ id, name, description, aliases, parentId, location }) => ({
        id, name, description, aliases, parentId, kind: location.kind,
      })),
    },
  }
}

/** Report sent to agents: placements, measurements, catalog, and region-map summary. */
export function sceneReport(record) {
  const scene = record.history.current()
  return {
    volume: scene.volume,
    objectCount: scene.objects.length,
    ...summaryOf(record),
    design: agentDesign(record.source?.state()),
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

/** Keep per-vertex deformation offsets in the saved recipe when reporting controls to agents. */
export function modelContextJson(value) {
  return JSON.stringify(value, (key, entry) => {
    if (key === 'fields' && Array.isArray(entry)) {
      return entry.map(({ offsets, ...field }) => ({ ...field, offsetCount: offsets.length }))
    }
    return entry
  })
}

/** Exact source and measurement context awaited by `viewer_load`. */
export function loadIdentity(record) {
  const design = record.source?.state()
  return design ? {
    path: design.path,
    revision: design.revision,
    url: design.url,
    transform: design.transform,
    volume: record.history.current().volume,
    ...(design.renderRequest ? { renderRequest: design.renderRequest } : {}),
  } : null
}

/**
 * Own session-scoped scene records, LRU eviction, serialized source loading, and model discovery.
 * @param {object} deps - Shared viewer services.
 * @returns {object} Session store operations and lifecycle disposal.
 */
export function createViewerSessions({ ctx, loads, receipts, events, cursors, focus, validation }) {
  const sessions = new Map()
  const evictions = new Set()
  let closed = false

  const displaySource = record => record.source
  const displayIdentity = record => cursorIdentity({ ...record, source: displaySource(record) })

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
    const candidate = await createSource(ctx, resolve(cwd, path), cwd).catch(error => {
      if (error.code === 'INACTIVE_EFFECT') throw new Error('Model preview is closed', { cause: error })
      throw error
    })
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
        await source.poll({ force: true })
        source.requestRender()
      } else await record.source?.dispose()
      record.source = source
      record.cwd = cwd
      record.selectedModel = selected
      record.catalogError = null
      if (volume !== undefined) {
        record.history.apply({ type: 'setVolume', volume })
        refreshMeasurements(record)
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

  return {
    sessions,
    isClosed: () => closed,
    close: () => { closed = true },
    evictions,
    displaySource,
    displayIdentity,
    recordFor,
    serialize,
    directoryFor,
    loadSource,
    discover,
  }
}
