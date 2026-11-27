// @vitest-environment jsdom
/** Local input remains authoritative while delayed host state arrives. */
import React, { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createAnalogPanel } from '../plugins/print-studio/viewer/analog/controls.js'
import { INITIAL_VALUES } from '../plugins/print-studio/viewer/analog/spec.js'

it('drags the centered curve handle vertically through its range and resets it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const render = (freezeRequested = false) => { root.render(React.createElement(Panel, {
    spec: { id: 'curve', label: 'Profile', values: { height: 0 }, freezeRequested, controls: [
      { kind: 'curve', label: 'Height', axes: [{ key: 'height', min: -10, max: 10, step: .5, reset: 0 }] },
    ] }, t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key, onChange: changed, onRelease: released,
  })) }
  try {
    await act(async () => { render() })
    const curve = container.querySelector<HTMLElement>('.av-curve')!, handle = curve.querySelector<HTMLElement>('.av-handle')!
    expect({ orientation: curve.getAttribute('aria-orientation'), handle: handle.getAttribute('style'),
      path: curve.querySelector('path')!.getAttribute('d') }).toMatchSnapshot()
    const captured = new Set<number>()
    curve.setPointerCapture = (id) => { captured.add(id) }
    curve.hasPointerCapture = id => captured.has(id)
    curve.releasePointerCapture = (id) => { captured.delete(id) }
    vi.spyOn(curve, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 100))
    const pointer = async (type: string, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 200, clientY: y })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await act(async () => curve.dispatchEvent(event))
    }
    await pointer('pointerdown', 150)
    expect(changed).toHaveBeenLastCalledWith({ height: 0 })
    await pointer('pointermove', 110)
    expect(changed).toHaveBeenLastCalledWith({ height: 10 })
    expect(handle.style.left).toBe('50%')
    expect(handle.style.top).toBe('10%')
    await pointer('pointermove', 190)
    expect(changed).toHaveBeenLastCalledWith({ height: -10 })
    expect(handle.style.top).toBe('90%')
    await pointer('pointerup', 190)
    expect(released).toHaveBeenLastCalledWith({ height: -10 })
    expect(captured.size).toBe(0)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Reset Height"]')!.click() })
    expect(released).toHaveBeenLastCalledWith({ height: 0 })
    expect(handle.style.top).toBe('50%')
    await act(async () => { render(true) })
    changed.mockClear()
    await pointer('pointerdown', 110)
    expect(changed).not.toHaveBeenCalled()
  } finally { await act(async () => { root.unmount() }); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

it('does not rewind a local adjustment when an older server echo arrives', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), Panel = createAnalogPanel(React), changed = vi.fn(), released = vi.fn()
  const render = (id: string, amount: number, frozen = false, freezeRequested = false) => { root.render(React.createElement(Panel, {
    spec: { id, operation: 'bulge', label: 'Back', values: { ...INITIAL_VALUES, amount }, frozen, freezeRequested },
    t: (key: string) => key, onChange: changed, onRelease: released,
  })) }
  try {
    await act(async () => { render('first', .65) })
    const input = container.querySelector<HTMLInputElement>('input')!
    await act(async () => { input.value = '.9'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(input.value).toBe('0.9')
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ amount: .9 }))
    await act(async () => { render('first', .7) })
    expect(input.value).toBe('0.9')
    await act(async () => { render('first', .7, false, true) })
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('0.9')
    await act(async () => { render('first', .7, true, true) })
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('[role=status]')?.textContent).toBe('shapeFrozen')
    await act(async () => { render('second', .3) })
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('0.3')
  } finally {
    await act(async () => { root.unmount() })
    container.remove(); vi.unstubAllGlobals()
  }
})


it('offers only continuous height and orientation controls for a cut', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React), changed = vi.fn()
  try {
    await act(async () => { root.render(React.createElement(Panel, {
      spec: { id: 'cut', operation: 'cut', label: 'Bottom', values: INITIAL_VALUES },
      t: (key: string) => key, onChange: changed, onRelease: vi.fn(),
    })) })
    expect([...container.querySelectorAll('input')].map(input => input.getAttribute('aria-label'))).toEqual(['cutHeight', 'cutTilt', 'cutLean'])
    expect(container.querySelector('.av-pad')).toBeNull()
    const height = container.querySelector('input')!
    await act(async () => { height.value = '.7'; height.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ amount: .7 }))
  } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
})

it.each(['cut', 'bulge'])('resets each %s control to exact neutral values without touching the others', async (operation) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const values = { amount: .8, spread: .3, angle: .7, peakX: .2, peakY: .9, falloff: .1 }
  const render = (freezeRequested = false) => { root.render(React.createElement(Panel, {
    spec: { id: operation, operation, label: 'Region', values, freezeRequested },
    t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key, onChange: changed, onRelease: released,
  })) }
  try {
    await act(async () => { render() })
    const keys = operation === 'cut' ? [['cutTilt', 'angle'], ['cutLean', 'spread'], ['cutHeight', 'amount']] : [['shapePeak', 'peakX', 'peakY'], ['shapeCurve', 'falloff'], ['shapeAmount', 'amount'], ['shapeSpread', 'spread'], ['shapeAngle', 'angle']]
    const expected = { ...values }
    for (const [label, ...fields] of keys) {
      for (const field of fields) expected[field as keyof typeof expected] = .5
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Reset ${label}"]`)!
      await act(async () => { button.click() })
      expect(changed).toHaveBeenLastCalledWith(expected)
      expect(released).toHaveBeenLastCalledWith(expected)
      await act(async () => { render() })
      expect(changed).toHaveBeenLastCalledWith(expected)
    }
    const count = released.mock.calls.length
    await act(async () => { render(true) })
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(released).toHaveBeenCalledTimes(count)
  } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
})

it('binds custom labels, units, resets and stepped pad/curve keyboard input', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const axis = (key: string, min: number, max: number, step: number, reset: number) => ({ key, min, max, step, reset })
  try {
    await act(async () => { root.render(React.createElement(Panel, {
      spec: { id: 'custom', operation: 'parameters', label: 'Eyes', values: { tilt: 10, x: 0, z: 0, roundness: 3 }, controls: [
        { kind: 'slider', label: 'Eye tilt', axes: [axis('tilt', -25, 25, .5, 10)] },
        { kind: 'pad', label: 'Position', axes: [axis('x', -50, 50, 3, 0), axis('z', -20, 20, 2, 0)] },
        { kind: 'curve', label: 'Roundness', axes: [axis('roundness', 1, 9, 1, 3)] },
      ] }, t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key, onChange: changed, onRelease: released,
    })) })
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Eye tilt"]')!
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['-25', '25', '0.5', '10'])
    await act(async () => { slider.value = '-12.5'; slider.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(changed).toHaveBeenLastCalledWith({ tilt: -12.5, x: 0, z: 0, roundness: 3 })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Reset Eye tilt"]')!.click() })
    expect(slider.value).toBe('10')
    await act(async () => container.querySelector('[aria-label="Position"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(released).toHaveBeenLastCalledWith({ tilt: 10, x: 3, z: 0, roundness: 3 })
    await act(async () => container.querySelector('[aria-label="Roundness"][role="slider"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(released).toHaveBeenLastCalledWith({ tilt: 10, x: 3, z: 0, roundness: 4 })
  } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
})

it('tracks dirty reset triggers, groups adjacent spatial wells, and supports double-click reset', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const axis = (key: string, min: number, max: number, step: number, reset: number) => ({ key, min, max, step, reset })
  try {
    await act(async () => { root.render(React.createElement(Panel, {
      spec: { id: 'glass', operation: 'parameters', label: 'Crest', values: { height: 0, peakX: .5, peakY: .5, curve: .5 }, controls: [
        { kind: 'slider', label: 'Height', axes: [axis('height', -10, 10, 1, 0)] },
        { kind: 'pad', label: 'Peak', axes: [axis('peakX', 0, 1, .05, .5), axis('peakY', 0, 1, .05, .5)] },
        { kind: 'curve', label: 'Softness', axes: [axis('curve', 0, 1, .05, .5)] },
      ] }, t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key === 'shapeResetAction' ? 'Reset' : key,
      onChange: changed, onRelease: released,
    })) })
    const section = container.querySelector('section.av-controls')!
    expect(section.classList.contains('av-glass')).toBe(true)
    expect(container.querySelectorAll('.av-spatial .av-field')).toHaveLength(2)
    const resetHeight = container.querySelector<HTMLButtonElement>('button[aria-label="Reset Height"]')!
    expect(resetHeight.dataset.dirty).toBe('false')
    expect(resetHeight.querySelector('.av-reset-dot')).not.toBeNull()
    expect(resetHeight.querySelector('.av-reset-label')?.textContent).toBe('Reset')
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Height"]')!
    await act(async () => { slider.value = '6'; slider.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(resetHeight.dataset.dirty).toBe('true')
    await act(async () => { slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(slider.value).toBe('0')
    expect(resetHeight.dataset.dirty).toBe('false')
    expect(released).toHaveBeenLastCalledWith({ height: 0, peakX: .5, peakY: .5, curve: .5 })
  } finally { await act(async () => { root.unmount() }); vi.unstubAllGlobals() }
})

it('hides occluded joint pins even though visible pins use grid centering', () => {
  const css = readFileSync(resolve(__dirname, '../plugins/print-studio/viewer/viewer.module.css'), 'utf8')
  const style = document.createElement('style')
  style.textContent = css
  const viewer = document.createElement('section')
  viewer.className = 'rumi-print-viewer'
  const pin = document.createElement('button')
  pin.className = 'pv-joint-target'
  pin.hidden = true
  viewer.append(pin)
  document.head.append(style)
  document.body.append(viewer)
  try {
    expect(getComputedStyle(pin).display).toBe('none')
    pin.hidden = false
    expect(getComputedStyle(pin).display).toBe('grid')
  } finally {
    viewer.remove()
    style.remove()
  }
})
