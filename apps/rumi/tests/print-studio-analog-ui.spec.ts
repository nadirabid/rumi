// @vitest-environment jsdom
/** Local input remains authoritative while delayed host state arrives. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createAnalogPanel } from '../brand/print-studio/viewer/analog/controls.js'
import { INITIAL_VALUES } from '../brand/print-studio/viewer/analog/spec.js'

it('does not rewind a local adjustment when an older server echo arrives', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), Panel = createAnalogPanel(React), changed = vi.fn(), released = vi.fn()
  const render = (id: string, amount: number, frozen = false, freezeRequested = false) => root.render(React.createElement(Panel, {
    spec: { id, operation: 'bulge', label: 'Back', values: { ...INITIAL_VALUES, amount }, frozen, freezeRequested },
    t: (key: string) => key, onChange: changed, onRelease: released,
  }))
  try {
    await act(async () => render('first', .65))
    const input = container.querySelector<HTMLInputElement>('input')!
    await act(async () => { input.value = '.9'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(input.value).toBe('0.9')
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ amount: .9 }))
    await act(async () => render('first', .7))
    expect(input.value).toBe('0.9')
    await act(async () => render('first', .7, false, true))
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('0.9')
    await act(async () => render('first', .7, true, true))
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('[role=status]')?.textContent).toBe('shapeFrozen')
    await act(async () => render('second', .3))
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('0.3')
  } finally {
    await act(async () => root.unmount())
    container.remove(); vi.unstubAllGlobals()
  }
})


it('offers only continuous height and orientation controls for a cut', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React), changed = vi.fn()
  try {
    await act(async () => root.render(React.createElement(Panel, {
      spec: { id: 'cut', operation: 'cut', label: 'Bottom', values: INITIAL_VALUES },
      t: (key: string) => key, onChange: changed, onRelease: vi.fn(),
    })))
    expect([...container.querySelectorAll('input')].map(input => input.getAttribute('aria-label'))).toEqual(['cutHeight', 'cutTilt', 'cutLean'])
    expect(container.querySelector('.av-pad')).toBeNull()
    const height = container.querySelector('input')!
    await act(async () => { height.value = '.7'; height.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ amount: .7 }))
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it.each(['cut', 'bulge'])('resets each %s control to exact neutral values without touching the others', async (operation) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const values = { amount: .8, spread: .3, angle: .7, peakX: .2, peakY: .9, falloff: .1 }
  const render = (freezeRequested = false) => root.render(React.createElement(Panel, {
    spec: { id: operation, operation, label: 'Region', values, freezeRequested },
    t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key, onChange: changed, onRelease: released,
  }))
  try {
    await act(async () => render())
    const keys = operation === 'cut' ? [['cutTilt', 'angle'], ['cutLean', 'spread'], ['cutHeight', 'amount']] : [['shapePeak', 'peakX', 'peakY'], ['shapeCurve', 'falloff'], ['shapeAmount', 'amount'], ['shapeSpread', 'spread'], ['shapeAngle', 'angle']]
    const expected = { ...values }
    for (const [label, ...fields] of keys) {
      for (const field of fields) expected[field as keyof typeof expected] = .5
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Reset ${label}"]`)!
      await act(async () => button.click())
      expect(changed).toHaveBeenLastCalledWith(expected)
      expect(released).toHaveBeenLastCalledWith(expected)
      await act(async () => render())
      expect(changed).toHaveBeenLastCalledWith(expected)
    }
    const count = released.mock.calls.length
    await act(async () => render(true))
    expect([...container.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(released).toHaveBeenCalledTimes(count)
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})

it('binds custom labels, units, resets and stepped pad/curve keyboard input', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), Panel = createAnalogPanel(React)
  const changed = vi.fn(), released = vi.fn()
  const axis = (key: string, min: number, max: number, step: number, reset: number) => ({ key, min, max, step, reset })
  try {
    await act(async () => root.render(React.createElement(Panel, {
      spec: { id: 'custom', operation: 'parameters', label: 'Eyes', values: { tilt: 10, x: 0, z: 0, roundness: 3 }, controls: [
        { kind: 'slider', label: 'Eye tilt', axes: [axis('tilt', -25, 25, .5, 10)] },
        { kind: 'pad', label: 'Position', axes: [axis('x', -50, 50, 3, 0), axis('z', -20, 20, 2, 0)] },
        { kind: 'curve', label: 'Roundness', axes: [axis('roundness', 1, 9, 1, 3)] },
      ] }, t: (key: string) => key === 'shapeReset' ? 'Reset {control}' : key, onChange: changed, onRelease: released,
    })))
    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Eye tilt"]')!
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['-25', '25', '0.5', '10'])
    await act(async () => { slider.value = '-12.5'; slider.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(changed).toHaveBeenLastCalledWith({ tilt: -12.5, x: 0, z: 0, roundness: 3 })
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Reset Eye tilt"]')!.click())
    expect(slider.value).toBe('10')
    await act(async () => container.querySelector('[aria-label="Position"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(released).toHaveBeenLastCalledWith({ tilt: 10, x: 3, z: 0, roundness: 3 })
    await act(async () => container.querySelector('[aria-label="Roundness"][role="slider"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(released).toHaveBeenLastCalledWith({ tilt: 10, x: 3, z: 0, roundness: 4 })
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})
