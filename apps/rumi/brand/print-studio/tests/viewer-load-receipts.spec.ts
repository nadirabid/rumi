import { afterEach, expect, it, vi } from 'vitest'
import { createLoadReceipts } from '../viewer/load-receipts.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function identity() {
  return {
    path: '/project/models/part/model.glb', revision: 2, url: '/preview/2/model.glb',
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    volume: { x: 300, y: 320, z: 320 },
  }
}

it('waits for matching measured feedback and passes its scene through unchanged', async () => {
  vi.useFakeTimers()
  const receipts = createLoadReceipts(1000)
  try {
    const pending = receipts.wait('a', identity(), new AbortController().signal)
    receipts.update('other', identity(), { status: 'ready' })
    receipts.update('a', identity())
    expect(vi.getTimerCount()).toBe(1)
    const outcome = { status: 'ready', scene: { design: { report: { triangleCount: 12 } } } }
    receipts.update('a', identity(), outcome)
    expect(await pending).toEqual(outcome)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    receipts.dispose()
    vi.useRealTimers()
  }
})

it.each(['path', 'revision', 'url', 'transform', 'volume'] as const)(
  'supersedes a pending load when its %s changes', async (field) => {
    vi.useFakeTimers()
    const receipts = createLoadReceipts(1000)
    try {
      const pending = receipts.wait('a', identity(), new AbortController().signal)
      const changed = identity()
      switch (field) {
        case 'path': changed.path = '/project/models/other/model.glb'; break
        case 'revision': changed.revision++; break
        case 'url': changed.url = '/preview/3/model.glb'; break
        case 'transform': changed.transform.position[0] = 10; break
        case 'volume': changed.volume.x = 250; break
      }
      receipts.update('a', changed, { status: 'ready', scene: { stale: true } })
      expect(await pending).toEqual({ status: 'superseded' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      receipts.dispose()
      vi.useRealTimers()
    }
  },
)

it('replaces only the same session wait and removes the replaced abort listener', async () => {
  vi.useFakeTimers()
  const receipts = createLoadReceipts(1000)
  try {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const first = receipts.wait('a', identity(), controller.signal)
    const other = receipts.wait('b', identity(), new AbortController().signal)
    const next = receipts.wait('a', identity(), new AbortController().signal)
    expect(await first).toEqual({ status: 'superseded' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(vi.getTimerCount()).toBe(2)
    receipts.update('a', identity(), { status: 'ready' })
    expect(await next).toEqual({ status: 'ready' })
    receipts.update('b', identity(), { status: 'failed', error: 'Invalid geometry' })
    expect(await other).toEqual({ status: 'failed', error: 'Invalid geometry' })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    receipts.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

it('cancels aborted waits and rejects an already aborted signal without allocating a timer', async () => {
  vi.useFakeTimers()
  const receipts = createLoadReceipts(1000)
  try {
    const controller = new AbortController()
    const pending = receipts.wait('a', identity(), controller.signal)
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
    await expect(Promise.resolve().then(() => receipts.wait('a', identity(), controller.signal))).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    receipts.dispose()
    vi.useRealTimers()
  }
})

it('settles at its configured deadline and releases cancelled or disposed sessions', async () => {
  vi.useFakeTimers()
  const receipts = createLoadReceipts(1000)
  try {
    const timeout = receipts.wait('a', identity(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await timeout).toEqual({ status: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
    const cancelled = receipts.wait('a', identity(), new AbortController().signal)
    receipts.cancel('a')
    expect(await cancelled).toEqual({ status: 'unavailable' })
    const first = receipts.wait('a', identity(), new AbortController().signal)
    const second = receipts.wait('b', identity(), new AbortController().signal)
    receipts.dispose()
    expect(await first).toEqual({ status: 'unavailable' })
    expect(await second).toEqual({ status: 'unavailable' })
    expect(vi.getTimerCount()).toBe(0)
    receipts.update('a', identity(), { status: 'ready' })
    expect(await receipts.wait('c', identity(), new AbortController().signal)).toEqual({ status: 'unavailable' })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    receipts.dispose()
    vi.useRealTimers()
  }
})
