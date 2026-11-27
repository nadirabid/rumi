/** Activity owns one cancellable frame chain and respects visibility and reduced motion. */
import { afterEach, expect, it, vi } from 'vitest'
import { ACTIVITY_MODES, createActivity } from '../viewer/viewport/activity.js'

afterEach(() => vi.unstubAllGlobals())

it('schedules only visible work, caps redraws, and stops for reduced motion and disposal', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {}
  const reduced = Object.assign(new EventTarget(), { matches: false })
  const document = Object.assign(new EventTarget(), { hidden: false })
  const disconnect = vi.fn(), render = vi.fn()
  vi.stubGlobal('window', { matchMedia: () => reduced })
  vi.stubGlobal('document', document)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback }
    observe() {}
    disconnect = disconnect
  })
  const clock = createActivity({}, render)
  const frame = (time: number) => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(time)
  }
  try {
    intersect([{ isIntersecting: true }])
    expect(frames.size).toBe(0)
    clock.setMode('building')
    const uniform = clock.uniform.value
    expect(frames.size).toBe(1)
    render.mockClear()
    frame(0); frame(16); frame(34)
    expect(render).toHaveBeenCalledTimes(2)
    expect(clock.uniform.value).toBe(uniform)
    for (const time of [1600, 3200, 4800, 6400, 8000]) {
      frame(time)
      expect(frames.size).toBe(1)
      expect(clock.uniform.value.y).toBe((time % 3200) / 3200)
    }
    expect(render).toHaveBeenCalledTimes(7)
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1)
    clock.setMode('checking')
    expect(clock.uniform.value.x).toBe(2)
    for (const stage of ['sculpt', 'regions', 'collision', 'fdm', 'mechanics', 'look', 'controls'] as const) {
      clock.setMode(stage)
      expect(clock.mode).toBe(stage)
      expect(clock.uniform.value.x).toBe(ACTIVITY_MODES[stage])
    }
    clock.setMode('unknown-future-stage')
    expect(clock.mode).toBe('building')
    expect(clock.uniform.value.x).toBe(ACTIVITY_MODES.building)
    clock.setMode('checking')
    expect(clock.uniform.value.x).toBe(2)
    reduced.matches = true; reduced.dispatchEvent(new Event('change'))
    expect(frames.size).toBe(0)
    expect(clock.uniform.value.y).toBe(0.5)
    reduced.matches = false; reduced.dispatchEvent(new Event('change'))
    intersect([{ isIntersecting: false }])
    expect(frames.size).toBe(0)
    intersect([{ isIntersecting: true }])
    clock.setMode('idle')
    expect(frames.size).toBe(0)
    clock.setMode('checking')
  } finally { clock.dispose() }
  expect(frames.size).toBe(0)
  expect(disconnect).toHaveBeenCalledOnce()
  render.mockClear()
  reduced.dispatchEvent(new Event('change'))
  document.dispatchEvent(new Event('visibilitychange'))
  expect(render).not.toHaveBeenCalled()
})
