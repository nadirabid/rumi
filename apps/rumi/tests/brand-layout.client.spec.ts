// @vitest-environment jsdom
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

const buildScript = resolve(import.meta.dirname, '../scripts/build-plugins.mjs')
beforeAll(() => { execFileSync(process.execPath, [buildScript, 'brand']) })

let dispose: (() => void) | undefined
function mountEffect(effectLabel: string) {
  const source = readFileSync('apps/rumi/plugins/brand/lib/client.js', 'utf8')
  const context = {
    effect(effect: () => (() => void), label: string) {
      if (label === effectLabel) dispose = effect()
    },
    slots: { inject() {} },
    inject() {},
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
}

function mountViewer() {
  mountEffect('rumi-brand: responsive viewer layout')
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
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('drags from the rendered divider without jumping and retains a proportional override until reset', () => {
  const { frame, handle } = mountViewer()
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
  const { frame, handle } = mountViewer()
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

it('reveals the transcript scrollbar only for its own scroll activity and clears it after a pause', () => {
  vi.useFakeTimers()
  mountEffect('rumi-brand: transient chat scrollbar')
  document.body.innerHTML = `
    <main data-conversation-region="chat">
      <div data-conversation-scroll><div data-composer-seat></div></div>
    </main>
    <aside data-conversation-scroll></aside>
  `
  const transcript = document.querySelector('[data-conversation-scroll]')!
  const composer = document.querySelector('[data-composer-seat]')!
  const preview = document.querySelector('aside')!
  const visible = () => transcript.hasAttribute('data-rumi-chat-scrolling')

  composer.dispatchEvent(new Event('scroll'))
  preview.dispatchEvent(new Event('scroll'))
  expect(visible()).toBe(false)
  expect(preview.hasAttribute('data-rumi-chat-scrolling')).toBe(false)

  transcript.dispatchEvent(new Event('scroll'))
  expect(visible()).toBe(true)
  vi.advanceTimersByTime(400)
  transcript.dispatchEvent(new Event('scroll'))
  vi.advanceTimersByTime(499)
  expect(visible()).toBe(true)
  vi.advanceTimersByTime(1)
  expect(visible()).toBe(false)

  transcript.dispatchEvent(new Event('scroll'))
  dispose?.()
  dispose = undefined
  expect(visible()).toBe(false)
  expect(document.getElementById('rumi-chat-scrollbar')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  transcript.dispatchEvent(new Event('scroll'))
  expect(visible()).toBe(false)
})
