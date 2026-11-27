// @vitest-environment jsdom
/** Microphone acquisition and release remain owned during interrupted startup. */
import * as React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'

type Loaded = { factory: (require: (name: string) => unknown) => { apply: (ctx: object) => void } }
let loaded: Loaded
const disposers: (() => void | Promise<void>)[] = []
const buildScript = resolve(import.meta.dirname, '../../../scripts/build-plugins.mjs')
const clientBundle = resolve(import.meta.dirname, '../lib/client.js')
beforeAll(() => {
  execFileSync(process.execPath, [buildScript, 'live-voice'])
  window.__ModuleLoader__ = { load: (entry: Loaded) => { loaded = entry } }
  new Function('window', readFileSync(clientBundle, 'utf8'))(window)
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
  const offering = deferred<undefined>()
  const closing = deferred<undefined>()
  const closed = deferred<Response>()
  const remoteSet = deferred<undefined>()
  const stopTrack = vi.fn()
  const closePeer = vi.fn()
  const track = Object.assign(new EventTarget(), { enabled: true, stop: stopTrack })
  const events = new EventTarget()
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as MediaStream
  const setRemoteDescription = vi.fn(async (_answer: RTCSessionDescriptionInit) => { remoteSet.resolve(undefined) })
  const addTrack = vi.fn()
  const createDataChannel = vi.fn(() => events)
  vi.stubGlobal('RTCPeerConnection', class extends EventTarget {
    iceGatheringState = 'complete'
    localDescription = { type: 'offer', sdp: 'v=0 test offer' }
    addTrack = addTrack
    createDataChannel = createDataChannel
    createOffer = async () => this.localDescription
    setLocalDescription = async () => {}
    setRemoteDescription = setRemoteDescription
    close = closePeer
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => { acquiring.resolve(undefined); return microphone.promise } } })
  const fetch = vi.fn((input: string, init: RequestInit) => {
    if (input.endsWith('/session')) { offering.resolve(undefined); return started.promise }
    if (input.endsWith('/poll') && firstPoll) { firstPoll = false; return ready.promise }
    if (input.endsWith('/close')) { closing.resolve(undefined); return closed.promise }
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error('Capture stopped'))
      else init.signal?.addEventListener('abort', () => { reject(new Error('Capture stopped')) }, { once: true })
    })
  })
  vi.stubGlobal('fetch', fetch)
  let labels: Record<string, string> = {}
  const t = (key: string) => labels[key] ?? key
  const components = new Map<string, React.ComponentType<{ sessionId: string; t: (key: string) => string }>>()
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
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
  const respond = () => started.resolve(new Response(JSON.stringify({ liveId: 'live', sdp: 'test answer' })))
  const grant = async () => { await acquiring.promise; microphone.resolve(stream); await offering.promise }
  const connected = async () => {
    respond()
    await remoteSet.promise
    events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.started' }) }))
  }
  const finishClose = () => closed.resolve(new Response(null, { status: 204 }))
  // Resolve deferred resources before plugin disposal even if an assertion fails.
  disposers.unshift(async () => {
    respond()
    microphone.resolve(stream)
    finishClose()
    ready.resolve(new Response(JSON.stringify({ events: [] })))
  })
  return {
    view, switchSession: (sessionId: string) => view.rerender(<Voice sessionId={sessionId} t={t} />),
    begin, stop, ready, grant, connected, started, respond, microphone, closing, stopTrack, closePeer,
    track, stream, addTrack, createDataChannel, setRemoteDescription, fetch, finishClose,
  }
}

it('closes a late host session without installing the remote answer after Stop', async () => {
  const f = fixture()
  f.begin()
  await act(f.grant)
  f.stop()
  expect(f.stopTrack).toHaveBeenCalledOnce()
  await act(async () => {
    f.respond()
    await f.closing.promise
  })
  expect(f.setRemoteDescription).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Start live voice session' })).toBeTruthy()
  f.finishClose()
})

it('releases a microphone granted after the component unmounts', async () => {
  const f = fixture()
  f.begin()
  f.view.unmount()
  await act(async () => { f.microphone.resolve(f.stream) })
  expect(f.stopTrack).toHaveBeenCalledOnce()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('shows a busy message and releases the microphone when another window owns voice', async () => {
  const f = fixture()
  f.begin()
  await act(f.grant)
  await act(async () => {
    f.started.resolve(new Response(JSON.stringify({ code: 'voice_busy', error: 'Live Voice is already in use' }), { status: 409 }))
  })
  expect(screen.getByRole('alert').textContent).toBe('Live Voice is busy. Try again when it ends.')
  expect(f.stopTrack).toHaveBeenCalledOnce()
  expect(f.setRemoteDescription).not.toHaveBeenCalled()
})

it('negotiates one WebRTC track and stops local capture before a delayed host close response', async () => {
  const f = fixture()
  f.begin()
  await act(f.grant)
  expect(f.track.enabled).toBe(false)
  expect(f.addTrack).toHaveBeenCalledWith(f.track, f.stream)
  expect(f.createDataChannel).toHaveBeenCalledWith('oai-events')
  expect(f.fetch).toHaveBeenCalledWith('/api/live-voice/session',
    expect.objectContaining({ body: JSON.stringify({ sessionId: 's', sdp: 'v=0 test offer' }) }))
  await act(f.connected)
  expect(f.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'test answer' })
  expect(f.track.enabled).toBe(true)
  f.stop()
  expect(f.stopTrack).toHaveBeenCalledOnce()
  await act(async () => { await f.closing.promise })
  expect(f.closePeer).not.toHaveBeenCalled()
  await act(async () => { f.finishClose() })
  expect(f.closePeer).toHaveBeenCalledOnce()
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
  await act(f.grant)
  expect(voice.getAttribute('aria-busy')).toBe('true')
  await act(f.connected)
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
  expect(f.track.enabled).toBe(false)
  fireEvent.keyDown(mute, { key: 'Enter' })
  expect(screen.getByRole('button', { name: 'Mute microphone' }).textContent).toBe('')
  expect(mute.querySelector('line')).toBeNull()
  expect(f.track.enabled).toBe(true)
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
  await act(f.grant)
  await act(f.connected)
  expect(screen.getByRole('button', { name: 'End live voice session' }).getAttribute('aria-pressed')).toBe('true')
  f.switchSession('another-session')
  expect(screen.getByRole('button', { name: 'Start live voice session' }).getAttribute('aria-pressed')).toBe('false')
  expect(f.stopTrack).toHaveBeenCalledOnce()
  await f.closing.promise
  f.finishClose()
})


it.each([['dispatching', 'Sending request…'], ['accepted', 'Request accepted'], ['failed', 'Request not sent. Please try again.']])('shows verified handoff state %s independently of audio', async (state, label) => {
  const f = fixture()
  f.begin()
  await act(f.grant)
  await act(f.connected)
  await act(async () => { f.ready.resolve(new Response(JSON.stringify({ events: [{ type: 'ready' }, { type: 'handoff', state }] }))) })
  expect(screen.getByRole('status').textContent).toBe(label)
  f.switchSession('other')
  expect(screen.queryByRole('status')).toBeNull()
})


it('releases the microphone and resets the control when the host closes idle voice', async () => {
  const f = fixture()
  f.begin()
  await act(f.grant)
  await act(f.connected)
  await act(async () => {
    f.ready.resolve(new Response(JSON.stringify({ events: [{ type: 'closed', reason: 'idle_timeout' }], closed: true })))
    await f.closing.promise
  })
  expect(f.stopTrack).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Start live voice session' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Mute microphone' })).toBeNull()
  f.finishClose()
})
