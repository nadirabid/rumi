/** Session-scoped, on-demand cursor captures; requests never reuse earlier pointer state. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeSelection } from './highlight.js'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { encodeStl, parseStl, STL_LIMITS } from './stl.js'

const rendererUnavailableReasons = new Set(['viewer_not_open', 'viewer_closed', 'viewer_hidden', 'temporary_edit', 'movement_preview', 'print_layout'])
const meshUnavailableReasons = new Set(['unsupported_model', 'empty_selection', 'geometry_unavailable'])
const maxMeshBase64 = 4 * Math.ceil((84 + 50 * STL_LIMITS.maxTriangles) / 3)

/** Limit a cursor request to the existing image budget and one maximum-size binary STL. */
export const MAX_CURSOR_BODY_CHARS = 3_100_000 + maxMeshBase64

function readMesh(value, hasSurfaceSelection) {
  if (value.meshStl === undefined) {
    if (value.meshUnavailable === undefined) return {}
    if (!meshUnavailableReasons.has(value.meshUnavailable)) throw new Error('Invalid cursor mesh status')
    return { meshUnavailable: value.meshUnavailable }
  }
  const encoded = value.meshStl
  if (!value.identity.design || !hasSurfaceSelection || value.meshUnavailable !== undefined
    || typeof encoded !== 'string' || encoded.length > maxMeshBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid cursor mesh')
  }
  const meshBytes = Buffer.from(encoded, 'base64')
  if (meshBytes.length < 84 || 84 + 50 * meshBytes.readUInt32LE(80) !== meshBytes.length) throw new Error('Invalid cursor mesh')
  parseStl(meshBytes)
  return { meshBytes }
}

/**
 * Save validated cursor triangles in the project so an agent can read or highlight them.
 * @param {string} cwd Local project directory.
 * @param {Buffer} bytes Validated binary STL in model-local millimetres, Z up.
 * @param {AbortSignal} signal Snapshot cancellation.
 * @returns {Promise<{path: string, triangleCount: number}>} Project-relative path of the completed file.
 */
export async function saveCursorMesh(cwd, bytes, signal) {
  const directory = await geometryDirectory(cwd, 'cursor-selections')
  signal.throwIfAborted()
  const filename = `${randomUUID()}.stl`
  const absolutePath = join(directory, filename)
  const file = await open(absolutePath, 'wx', 0o600)
  try {
    try { await file.writeFile(bytes, { signal }) }
    finally { await file.close() }
    signal.throwIfAborted()
  } catch (error) {
    await unlink(absolutePath)
    throw error
  }
  return { path: `.rumi/cursor-selections/${filename}`, triangleCount: bytes.readUInt32LE(80) }
}

async function geometryDirectory(cwd, subdirectory) {
  let directory = await realpath(cwd)
  for (const name of ['.rumi', subdirectory]) {
    directory = join(directory, name)
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (await realpath(directory) !== directory) throw new Error('Geometry directory must stay inside the project')
  }
  return directory
}

/**
 * Save a content-addressed copy of a whole part in viewer triangle order.
 * @param {string} cwd Local project directory.
 * @param {Float32Array} positions Saved triangle vertices in model-local millimetres.
 * @param {AbortSignal} signal Tool cancellation.
 * @returns {Promise<object>} Project-relative binary STL path and triangle count.
 */
export async function saveAnalyzedMesh(cwd, positions, signal) {
  const directory = await geometryDirectory(cwd, 'surface-analysis')
  const bytes = Buffer.from(encodeStl(positions))
  const filename = `${createHash('sha256').update(bytes).digest('hex')}.stl`
  signal.throwIfAborted()
  await writeFileAtomic(join(directory, filename), bytes, { mode: 0o600 })
  return { path: `.rumi/surface-analysis/${filename}`, triangleCount: positions.length / 9 }
}

/**
 * Save an uncovered surface's exact part-local ranges when too large to return inline.
 * @param {string} cwd Local project directory.
 * @param {number[][]} faceRanges Half-open triangle index ranges.
 * @param {AbortSignal} signal Tool cancellation.
 * @returns {Promise<string>} Project-relative JSON file containing the range array.
 */
export async function saveAnalyzedRanges(cwd, faceRanges, signal) {
  const directory = await geometryDirectory(cwd, 'surface-analysis')
  const bytes = JSON.stringify(faceRanges)
  const filename = `${createHash('sha256').update(bytes).digest('hex')}.json`
  signal.throwIfAborted()
  await writeFileAtomic(join(directory, filename), bytes, { mode: 0o600 })
  signal.throwIfAborted()
  return `.rumi/surface-analysis/${filename}`
}

/**
 * Identify the geometry and placement a cursor region refers to.
 * @param {object} record - Viewer session record.
 * @returns {object} JSON identity shared with the rendered viewport.
 */
export function cursorIdentity(record) {
  const source = record.source?.state()
  return {
    sceneRevision: record.history.current().revision,
    design: source ? { path: source.path, revision: source.revision, url: source.url, transform: source.transform } : null,
  }
}

/**
 * Validate renderer JSON before it can become model-visible tool output.
 * @param {object} value - Untrusted snapshot response, excluding request id.
 * @returns {object} Validated snapshot; malformed responses throw without completing a request.
 */
export function validateCursorSnapshot(value) {
  if (!value || !['captured', 'no_hit', 'viewer_unavailable', 'stale_view', 'capture_failed'].includes(value.status)) throw new Error('Invalid cursor status')
  if (value.status === 'viewer_unavailable' && rendererUnavailableReasons.has(value.reason)) return { status: value.status, reason: value.reason }
  if (value.status !== 'captured') return { status: value.status }
  const vector = x => Array.isArray(x) && x.length === 3 && x.every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)
  const region = value.region
  if (typeof value.capturedAt !== 'string' || value.capturedAt.length > 40 || !Number.isFinite(Date.parse(value.capturedAt)) || !value.identity || !Number.isInteger(value.identity.sceneRevision)
    || (!region && !(region === null && value.namedRegion))) throw new Error('Invalid cursor region')
  let namedRegion
  if (value.namedRegion !== undefined) {
    const feature = value.namedRegion
    if (!value.identity.design || !feature || typeof feature.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(feature.id)
      || typeof feature.name !== 'string' || !feature.name.trim() || feature.name.length > 64
      || typeof feature.regionMapKey !== 'string' || !/^[a-f0-9]{64}$/u.test(feature.regionMapKey)) throw new Error('Invalid named cursor region')
    namedRegion = { id: feature.id, name: feature.name, regionMapKey: feature.regionMapKey }
  }
  if (region && (!(region.objectId === null || typeof region.objectId === 'string')
    || !Array.isArray(region.partPath) || region.partPath.length > 128 || !region.partPath.every(s => typeof s === 'string' && s.length <= 1000)
    || !Number.isInteger(region.faceIndex) || region.faceIndex < 0 || !vector(region.worldPoint)
    || !Number.isFinite(region.worldRadius) || region.worldRadius <= 0 || region.worldRadius > 1e9)) throw new Error('Invalid cursor region')
  const blob = region ? region.modelLocalBlob : null
  if (blob !== null && (!blob || !vector(blob.center) || !vector(blob.radii) || blob.radii.some(n => n <= 0) || !vector(blob.rotationDegrees))) throw new Error('Invalid model-local region')
  const modelLocalPoint = region?.modelLocalPoint === undefined ? blob?.center ?? null : region.modelLocalPoint
  if (modelLocalPoint !== null && !vector(modelLocalPoint)) throw new Error('Invalid saved model point')
  const selection = region?.selection === undefined ? undefined : normalizeSelection(region.selection)
  const mesh = readMesh(value, Boolean(namedRegion || (selection && modelLocalPoint)))
  const camera = value.camera
  if (!camera || !vector(camera.position) || !vector(camera.target) || !vector(camera.up)
    || !Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180
    || !Number.isFinite(camera.aspect) || camera.aspect <= 0) throw new Error('Invalid cursor camera')
  if (typeof value.image !== 'string' || value.image.length > 3_000_000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) throw new Error('Invalid cursor image')
  return {
    status: 'captured', capturedAt: value.capturedAt, identity: value.identity,
    ...mesh, ...(namedRegion ? { namedRegion } : {}),
    region: region ? { ...(selection ? { selection } : {}), objectId: region.objectId, partPath: region.partPath, faceIndex: region.faceIndex,
      worldPoint: region.worldPoint, worldRadius: region.worldRadius, modelLocalPoint, modelLocalBlob: blob === null ? null : { center: blob.center, radii: blob.radii, rotationDegrees: blob.rotationDegrees } } : null,
    camera: { position: camera.position, target: camera.target, up: camera.up, fov: camera.fov, aspect: camera.aspect },
    image: value.image,
  }
}

/**
 * Own pending captures until reply, cancellation, timeout, eviction, or plugin disposal.
 * @param {Function} [onRequest] Wake the mounted viewer after admission; omitted leaves delivery to polling.
 * @returns {object} Request, delivery, lookup and disposal operations.
 */
export function createCursorRequests(onRequest = () => {}) {
  const pending = new Map()
  let closed = false
  return {
    request(sessionId, identity, signal) {
      signal.throwIfAborted()
      if (closed) return Promise.resolve({ status: 'viewer_unavailable', reason: 'viewer_closed' })
      if (pending.has(sessionId)) return Promise.resolve({ status: 'busy' })
      return new Promise(resolve => {
        const id = randomUUID()
        const finish = value => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          pending.delete(sessionId)
          resolve(value)
        }
        const abort = () => finish({ status: 'cancelled' })
        const timer = setTimeout(() => finish({ status: 'viewer_unavailable', reason: 'response_timeout' }), 8000)
        pending.set(sessionId, { id, identity, finish })
        signal.addEventListener('abort', abort, { once: true })
        onRequest(sessionId)
      })
    },
    read(sessionId) { const request = pending.get(sessionId); return request ? { id: request.id } : null },
    deliver(sessionId, id, value, currentIdentity) {
      const request = pending.get(sessionId)
      if (!request || request.id !== id) return false
      const snapshot = validateCursorSnapshot(value)
      if (JSON.stringify(currentIdentity) !== JSON.stringify(request.identity)
        || (snapshot.status === 'captured' && JSON.stringify(snapshot.identity) !== JSON.stringify(request.identity))) {
        request.finish({ status: 'stale_view' })
      } else request.finish(snapshot)
      return true
    },
    cancel(sessionId) { pending.get(sessionId)?.finish({ status: 'viewer_unavailable', reason: 'scene_evicted' }) },
    dispose() {
      closed = true
      for (const request of [...pending.values()]) request.finish({ status: 'viewer_unavailable', reason: 'viewer_closed' })
    },
  }
}
