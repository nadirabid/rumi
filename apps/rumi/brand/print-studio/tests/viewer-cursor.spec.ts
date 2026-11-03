/** Cursor requests are session-local and complete only from a matching fresh response. */
import { afterEach, expect, it, vi } from 'vitest'
import { createCursorRequests, validateCursorSnapshot } from '../viewer/cursor.js'

afterEach(() => vi.useRealTimers())

const identity = { sceneRevision: 2, design: null }
function snapshot() {
  return { status: 'captured', capturedAt: '2026-11-03T20:00:00.000Z', identity,
    region: { objectId: 'part', partPath: ['box'], faceIndex: 0, worldPoint: [1, 2, 3], worldRadius: 4, modelLocalBlob: null },
    camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 40, aspect: 1 },
    image: 'data:image/png;base64,cG5n',
  }
}

it('matches both request and scene identities without reusing a completed capture', async () => {
  const broker = createCursorRequests()
  try {
    const first = broker.request('a', identity, new AbortController().signal)
    const request = broker.read('a')!
    expect(await broker.request('a', identity, new AbortController().signal)).toEqual({ status: 'busy' })
    expect(broker.deliver('b', request.id, snapshot(), identity)).toBe(false)
    expect(broker.deliver('a', 'old-id', snapshot(), identity)).toBe(false)
    expect(broker.deliver('a', request.id, snapshot(), identity)).toBe(true)
    expect(await first).toEqual(snapshot())
    expect(broker.read('a')).toBeNull()
    const next = broker.request('a', identity, new AbortController().signal)
    expect(broker.read('a')!.id).not.toBe(request.id)
    broker.deliver('a', broker.read('a')!.id, snapshot(), { ...identity, sceneRevision: 3 })
    expect(await next).toEqual({ status: 'stale_view' })
    const staleRenderer = broker.request('a', identity, new AbortController().signal)
    broker.deliver('a', broker.read('a')!.id, { ...snapshot(), identity: { ...identity, sceneRevision: 1 } }, identity)
    expect(await staleRenderer).toEqual({ status: 'stale_view' })
  } finally { broker.dispose() }
})

it('resolves pending work on timeout, cancellation, eviction and disposal', async () => {
  vi.useFakeTimers()
  const broker = createCursorRequests()
  try {
    const timeout = broker.request('a', identity, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await timeout).toEqual({ status: 'viewer_unavailable' })
    const controller = new AbortController()
    const aborted = broker.request('a', identity, controller.signal)
    controller.abort()
    expect(await aborted).toEqual({ status: 'cancelled' })
    expect(() => broker.request('a', identity, controller.signal)).toThrow()
    const evicted = broker.request('a', identity, new AbortController().signal)
    broker.cancel('a')
    expect(await evicted).toEqual({ status: 'viewer_unavailable' })
    const closing = broker.request('b', identity, new AbortController().signal)
    broker.dispose()
    expect(await closing).toEqual({ status: 'viewer_unavailable' })
    expect(vi.getTimerCount()).toBe(0)
    expect(await broker.request('c', identity, new AbortController().signal)).toEqual({ status: 'viewer_unavailable' })
  } finally { broker.dispose() }
})

it('rejects malformed region/image data and strips fields from non-captures', () => {
  expect(validateCursorSnapshot({ status: 'no_hit', image: 'stale' })).toEqual({ status: 'no_hit' })
  expect(() => validateCursorSnapshot({ ...snapshot(), image: 'data:text/html;base64,cG5n' })).toThrow('image')
  expect(() => validateCursorSnapshot({ ...snapshot(), region: { ...snapshot().region, worldRadius: NaN } })).toThrow('region')
  expect(() => validateCursorSnapshot({ ...snapshot(), region: { ...snapshot().region, modelLocalBlob: { center: [0, 0, 0], radii: [-1, 1, 1], rotationDegrees: [0, 0, 0] } } })).toThrow('model-local')
  expect(() => validateCursorSnapshot({ ...snapshot(), camera: { ...snapshot().camera, fov: 180 } })).toThrow('camera')
})
