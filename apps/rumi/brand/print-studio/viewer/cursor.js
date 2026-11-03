/** Session-scoped, on-demand cursor captures; requests never reuse earlier pointer state. */
import { randomUUID } from 'node:crypto'

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
  if (value.status !== 'captured') return { status: value.status }
  const vector = x => Array.isArray(x) && x.length === 3 && x.every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)
  const region = value.region
  if (typeof value.capturedAt !== 'string' || value.capturedAt.length > 40 || !Number.isFinite(Date.parse(value.capturedAt)) || !value.identity || !Number.isInteger(value.identity.sceneRevision)
    || !region || !(region.objectId === null || typeof region.objectId === 'string')
    || !Array.isArray(region.partPath) || region.partPath.length > 128 || !region.partPath.every(s => typeof s === 'string' && s.length <= 1000)
    || !Number.isInteger(region.faceIndex) || region.faceIndex < 0 || !vector(region.worldPoint)
    || !Number.isFinite(region.worldRadius) || region.worldRadius <= 0 || region.worldRadius > 1e9) throw new Error('Invalid cursor region')
  const blob = region.modelLocalBlob
  if (blob !== null && (!blob || !vector(blob.center) || !vector(blob.radii) || blob.radii.some(n => n <= 0) || !vector(blob.rotationDegrees))) throw new Error('Invalid model-local region')
  const camera = value.camera
  if (!camera || !vector(camera.position) || !vector(camera.target) || !vector(camera.up)
    || !Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180
    || !Number.isFinite(camera.aspect) || camera.aspect <= 0) throw new Error('Invalid cursor camera')
  if (typeof value.image !== 'string' || value.image.length > 3_000_000
    || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) throw new Error('Invalid cursor image')
  return {
    status: 'captured', capturedAt: value.capturedAt, identity: value.identity,
    region: { objectId: region.objectId, partPath: region.partPath, faceIndex: region.faceIndex,
      worldPoint: region.worldPoint, worldRadius: region.worldRadius, modelLocalBlob: blob === null ? null : { center: blob.center, radii: blob.radii, rotationDegrees: blob.rotationDegrees } },
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
      if (closed) return Promise.resolve({ status: 'viewer_unavailable' })
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
        const timer = setTimeout(() => finish({ status: 'viewer_unavailable' }), 8000)
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
    cancel(sessionId) { pending.get(sessionId)?.finish({ status: 'viewer_unavailable' }) },
    dispose() {
      closed = true
      for (const request of [...pending.values()]) request.finish({ status: 'viewer_unavailable' })
    },
  }
}
