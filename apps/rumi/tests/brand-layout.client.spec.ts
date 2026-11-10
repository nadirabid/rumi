// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

let dispose: (() => void) | undefined
function mount() {
  const source = readFileSync('apps/rumi/brand/client.js', 'utf8')
  const context = {
    effect(effect: () => (() => void), label: string) {
      if (label === 'rumi-brand: responsive viewer layout') dispose = effect()
    },
    slots: { inject() {} },
    locale: { bind: () => () => '' },
  }
  const loader = { load: (module: { factory: (require: () => object) => { apply: (ctx: typeof context) => void } }) => {
    module.factory(() => ({ createElement() {} })).apply(context)
  } }
  const host = Object.create(window)
  host.__ModuleLoader__ = loader
  host.addEventListener = window.addEventListener.bind(window)
  host.removeEventListener = window.removeEventListener.bind(window)
  new Function('window', source)(host)
  document.body.innerHTML = '<div data-sidebar-collapsed><div data-sidebar-right-panel="push" data-sidebar-right-open><section class="rumi-print-viewer"></section></div><div data-side="rightbar"></div></div>'
  const frame = document.body.firstElementChild as HTMLElement
  const handle = frame.lastElementChild as HTMLElement
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 20, width: 1200 } as DOMRect)
  vi.spyOn(handle, 'getBoundingClientRect').mockReturnValue({ left: 316, width: 8 } as DOMRect)
  handle.setPointerCapture = vi.fn()
  handle.hasPointerCapture = () => true
  handle.releasePointerCapture = vi.fn()
  return { frame, handle }
}
function pointer(target: EventTarget, type: string, x: number, id = 1) {
  const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerId', { value: id })
  target.dispatchEvent(event)
}
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.restoreAllMocks() })

it('drags from the rendered divider without jumping and retains a proportional override until reset', () => {
  const { frame, handle } = mount()
  const upstream = vi.fn()
  handle.addEventListener('pointerdown', upstream)
  pointer(handle, 'pointerdown', 322)
  pointer(handle, 'pointermove', 622, 2)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('')
  pointer(handle, 'pointermove', 622)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('50%')
  pointer(handle, 'pointerup', 622)
  expect(upstream).not.toHaveBeenCalled()
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('')
})

it('protects both pane minima and stops dragging on cancellation, blur, and disposal', () => {
  const { frame, handle } = mount()
  pointer(handle, 'pointerdown', 320)
  pointer(handle, 'pointermove', 0)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('20%')
  pointer(handle, 'pointermove', 2000)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('75%')
  pointer(handle, 'pointercancel', 2000)
  pointer(handle, 'pointermove', 500)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('75%')
  pointer(handle, 'pointerdown', 320)
  window.dispatchEvent(new Event('blur'))
  pointer(handle, 'pointermove', 500)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('75%')
  pointer(handle, 'pointerdown', 320)
  dispose?.(); dispose = undefined
  expect(document.getElementById('rumi-viewer-layout')).toBeNull()
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('')
  pointer(handle, 'pointermove', 500)
  expect(frame.style.getPropertyValue('--rumi-chat-share')).toBe('')
})
