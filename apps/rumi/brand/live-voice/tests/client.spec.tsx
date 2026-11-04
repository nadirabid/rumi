// @vitest-environment jsdom
/** Microphone acquisition and release remain owned during interrupted startup. */
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

type Loaded = { factory: (require: (name: string) => unknown) => { apply: (ctx: object) => void } }
let loaded: Loaded
const disposers: (() => void | Promise<void>)[] = []
beforeAll(async () => {
  window.__ModuleLoader__ = { load: (entry: Loaded) => { loaded = entry } }
  await import('../client/index.js')
})
afterEach(async () => {
  cleanup()
  await Promise.all(disposers.splice(0).map(async (dispose) => { await dispose() }))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
afterAll(() => { delete window.__ModuleLoader__ })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const started = deferred<Response>()
  const microphone = deferred<MediaStream>()
  const ready = deferred<Response>()
  let firstPoll = true
  const acquiring = deferred<undefined>()
  const closing = deferred<undefined>()
  const closed = deferred<Response>()
  const stopTrack = vi.fn()
  const closeAudio = vi.fn(async () => {})
  vi.stubGlobal('AudioContext', class {
    sampleRate = 24_000
    resume = async () => {}
    close = closeAudio
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} })
    createGain = () => ({ gain: { value: 0 }, connect: () => {} })
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null }
    connect(node: object) { return node }
    disconnect() {}
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => { acquiring.resolve(undefined); return microphone.promise } } })
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:voice-test' }
    static revokeObjectURL() {}
  })
  vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
    if (input.endsWith('/session')) return started.promise
    if (input.endsWith('/poll') && firstPoll) { firstPoll = false; return ready.promise }
    if (input.endsWith('/close')) { closing.resolve(undefined); return closed.promise }
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error('Capture stopped'))
      else init.signal?.addEventListener('abort', () => { reject(new Error('Capture stopped')) }, { once: true })
    })
  }))
  let labels: Record<string, string> = {}
  const t = (key: string) => labels[key] ?? key
  const components = new Map<string, React.ComponentType<{ sessionId: string; t: (key: string) => string }>>()
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`Unexpected module ${name}`)
  })
  plugin.apply({
    effect: (effect: () => () => void) => { const dispose = effect(); if (dispose) disposers.push(dispose) },
    locale: { register: (_name: string, values: { en: Record<string, string> }) => { labels = values.en; return () => {} } },
    slots: {
      inject: (_name: string, inject: () => void) => { inject() },
      register: (entry: { id?: string }, component: React.ComponentType<{ sessionId: string; t: (key: string) => string }>) => {
        if (entry.id) components.set(entry.id, component)
        return () => {}
      },
    },
  })
  const Voice = components.get('live-voice')!
  const view = render(<Voice sessionId="s" t={t} />)
  const begin = () => fireEvent.click(screen.getByRole('button', { name: 'Start live voice session' }))
  const stop = () => fireEvent.click(screen.getByRole('button', { name: 'End live voice session' }))
  // Resolve deferred resources before plugin disposal even if an assertion fails.
  disposers.unshift(async () => {
    started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    microphone.resolve({ getTracks: () => [{ stop: stopTrack }] } as MediaStream)
    closed.resolve(new Response(null, { status: 204 }))
    ready.resolve(new Response(JSON.stringify({ events: [] })))
  })
  return {
    view, switchSession: (sessionId: string) => view.rerender(<Voice sessionId={sessionId} t={t} />),
    begin, stop, ready, started, acquiring, microphone, closing, closed, stopTrack, closeAudio,
  }
}

it('closes a late host session without opening the microphone after Stop', async () => {
  const f = fixture()
  f.begin()
  f.stop()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.closing.promise
  })
  expect(f.closeAudio).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Start live voice session' })).toBeTruthy()
  f.closed.resolve(new Response(null, { status: 204 }))
})

it('releases a microphone granted after the component unmounts', async () => {
  const f = fixture()
  f.begin()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.acquiring.promise
  })
  f.view.unmount()
  await act(async () => {
    f.microphone.resolve({ getTracks: () => [{ stop: f.stopTrack }] } as MediaStream)
    await f.closing.promise
  })
  expect(f.stopTrack).toHaveBeenCalledOnce()
  expect(f.closeAudio).toHaveBeenCalledOnce()
  f.closed.resolve(new Response(null, { status: 204 }))
})

it('stops local capture before a delayed host close response', async () => {
  const f = fixture()
  f.begin()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.acquiring.promise
    f.microphone.resolve({ getTracks: () => [{ stop: f.stopTrack }] } as MediaStream)
  })
  f.stop()
  expect(f.stopTrack).toHaveBeenCalledOnce()
  expect(f.closeAudio).toHaveBeenCalledOnce()
  await act(async () => { f.ready.resolve(new Response(JSON.stringify({ events: [] }))); await f.closing.promise })
  f.closed.resolve(new Response(null, { status: 204 }))
})

it('shows a cancellable pending state until ready, then places mute left and reverses colors', async () => {
  const f = fixture()
  const voice = screen.getByRole('button', { name: 'Start live voice session' })
  const background = voice.querySelector('circle')!.getAttribute('fill')
  const foreground = voice.querySelector('rect')!.getAttribute('fill')
  expect(voice.getAttribute('aria-pressed')).toBe('false')
  f.begin()
  expect(voice.getAttribute('aria-busy')).toBe('true')
  expect(voice.getAttribute('aria-pressed')).toBe('false')
  expect(voice.querySelector('circle')!.getAttribute('fill')).toBe(background)
  expect(screen.queryByRole('button', { name: 'Mute microphone' })).toBeNull()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.acquiring.promise
    f.microphone.resolve({ getTracks: () => [{ stop: f.stopTrack }] } as MediaStream)
  })
  expect(voice.getAttribute('aria-busy')).toBe('true')
  await act(async () => { f.ready.resolve(new Response(JSON.stringify({ events: [{ type: 'ready' }] }))) })
  expect(voice.getAttribute('aria-busy')).toBe('false')
  const mute = screen.getByRole('button', { name: 'Mute microphone' })
  expect(mute.textContent).toBe('')
  expect(mute.querySelector('line')).toBeNull()
  fireEvent.click(mute)
  expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBe(mute)
  expect({ label: mute.textContent, muted: mute.getAttribute('aria-pressed') }).toMatchInlineSnapshot(`
    {
      "label": "",
      "muted": "true",
    }
  `)
  expect(mute.querySelector('line')).not.toBeNull()
  fireEvent.keyDown(mute, { key: 'Enter' })
  expect(screen.getByRole('button', { name: 'Mute microphone' }).textContent).toBe('')
  expect(mute.querySelector('line')).toBeNull()
  expect(mute.nextElementSibling).toBe(voice)
  expect(voice.parentElement!.lastElementChild).toBe(voice)
  expect(voice.getAttribute('aria-pressed')).toBe('true')
  expect(voice.querySelector('circle')!.getAttribute('fill')).toBe(foreground)
  expect(voice.querySelector('rect')!.getAttribute('fill')).toBe(background)
  f.stop()
  expect(screen.queryByRole('button', { name: 'Mute microphone' })).toBeNull()
  expect(voice.querySelector('circle')!.getAttribute('fill')).toBe(background)
})


it('stops the old connection and resets the button when the composer changes session', async () => {
  const f = fixture()
  f.begin()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.acquiring.promise
    f.microphone.resolve({ getTracks: () => [{ stop: f.stopTrack }] } as MediaStream)
    f.ready.resolve(new Response(JSON.stringify({ events: [{ type: 'ready' }] })))
  })
  expect(screen.getByRole('button', { name: 'End live voice session' }).getAttribute('aria-pressed')).toBe('true')
  f.switchSession('another-session')
  expect(screen.getByRole('button', { name: 'Start live voice session' }).getAttribute('aria-pressed')).toBe('false')
  expect(f.stopTrack).toHaveBeenCalledOnce()
  await f.closing.promise
  f.closed.resolve(new Response(null, { status: 204 }))
})


it.each([['dispatching', 'Sending request…'], ['accepted', 'Request accepted'], ['failed', 'Request not sent. Please try again.']])('shows verified handoff state %s independently of audio', async (state, label) => {
  const f = fixture()
  f.begin()
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ liveId: 'live' })))
    await f.acquiring.promise
    f.microphone.resolve({ getTracks: () => [{ stop: f.stopTrack }] } as MediaStream)
  })
  await act(async () => { f.ready.resolve(new Response(JSON.stringify({ events: [{ type: 'ready' }, { type: 'handoff', state }] }))) })
  expect(screen.getByRole('status').textContent).toBe(label)
  f.switchSession('other')
  expect(screen.queryByRole('status')).toBeNull()
})
