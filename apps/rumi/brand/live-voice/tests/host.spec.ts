/** Voice transports and pending starts belong to the plugin's Cordis lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { once } from 'node:events'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(acknowledge = true) {
  const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'rumi-voice-journal-'))
  cleanups.push(() => rm(diagnosticsDirectory, { recursive: true, force: true }))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Missing test address')
  const started = deferred<WebSocket>()
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      if (!Buffer.isBuffer(raw)) throw new Error('Expected a text frame')
      const event: unknown = JSON.parse(raw.toString('utf8'))
      if (event === null || typeof event !== 'object' || !('type' in event)) return
      frames.push(event as { type: string; session?: { instructions: string }; content?: string })
      if (event.type !== 'session.start') return
      started.resolve(socket)
      if (acknowledge) socket.send(JSON.stringify({ type: 'session.started', session: { id: 'live' } }))
    })
  })
  const owner = new Context()
  cleanups.push(() => owner.fiber.dispose())
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let key = 'test-secret-value'
  const entered = deferred<undefined>()
  const idle = deferred<undefined>()
  cleanups.push(async () => { idle.resolve(undefined) })
  let flushed = false
  const session = new Session(SessionId('s'))
  const other = new Session(SessionId('other'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Make the dragon red, with a handle.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  other.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Other conversation: a blue car.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const frames: { type: string; session?: { instructions: string }; content?: string }[] = []
  const ctx = {
    effect: owner.effect.bind(owner),
    provide: owner.provide.bind(owner),
    on: owner.on.bind(owner),
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } },
    credentials: {
      resolve: async () => ({ value: key }),
      set: async (_ref: string, value: string) => { key = value },
    },
    sessionController: { resolveAgent: async (id: string) => ({ agent: {
      session: id === 'other' ? other : session, steer: () => { entered.resolve(undefined) }, whenIdle: () => idle.promise,
    } }) },
    sessions: { flush: async () => { flushed = true } },
  }
  // The JavaScript plugin consumes only these service methods; Cordis owns the effects.
  apply(ctx as Context, { diagnosticsDirectory, endpoint: `ws://127.0.0.1:${address.port}` })
  const request = (path: string, body?: object) => routes.get(`/api/live-voice${path}`)!(new Request(`http://rumi${path}`, {
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
  }))
  return { diagnosticsDirectory, owner, session, other, frames, request, started, entered, idle, flushed: () => flushed, key: () => key }
}

it('closes an established socket when its Cordis owner unloads', async () => {
  const f = await fixture()
  expect((await f.request('/session', { sessionId: 's' })).status).toBe(200)
  const socket = await f.started.promise
  const closed = once(socket, 'close')
  await f.owner.fiber.dispose()
  await closed
  expect(socket.readyState).toBe(3)
})

it('rejects an overlapping start and aborts a handshake on unload', async () => {
  const f = await fixture(false)
  const pending = f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  expect((await f.request('/session', { sessionId: 's' })).status).toBe(409)
  const closed = once(socket, 'close')
  await f.owner.fiber.dispose()
  expect((await pending).status).not.toBe(200)
  await closed
})

it('waits for admitted harness work to flush during unload without dispatching queued work', async () => {
  const f = await fixture()
  await f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Make a cube' }))
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'first', target: 'client' } }))
  await f.entered.promise
  let disposed = false
  const disposal = f.owner.fiber.dispose().then(() => { disposed = true })
  await once(socket, 'close')
  expect(disposed).toBe(false)
  expect(f.flushed()).toBe(false)
  f.idle.resolve(undefined)
  await disposal
  expect(f.flushed()).toBe(true)
})

it('stores replacement keys in credentials and returns only masked status', async () => {
  const f = await fixture()
  const replacement = 'replacement-secret-value'
  const response = await f.request('/settings', { apiKey: replacement })
  const body: unknown = await response.json()
  expect(f.key()).toBe(replacement)
  expect(body).toMatchObject({ hasKey: true, hint: 'replace…alue' })
  expect(body).not.toHaveProperty('key')
  expect(JSON.stringify(body)).not.toContain(replacement)
  expect(await (await f.request('/settings')).json()).toEqual(body)
})


it('sends only the selected session history in session.start', async () => {
  const f = await fixture()
  await f.request('/session', { sessionId: 's' })
  expect(f.frames[0]?.session?.instructions).toContain('Make the dragon red, with a handle.')
  expect(f.frames[0]?.session?.instructions).not.toContain('blue car')
  await f.request('/session', { sessionId: 'other' })
  const starts = f.frames.filter(frame => frame.type === 'session.start')
  expect(starts[1]?.session?.instructions).toContain('Other conversation: a blue car.')
  expect(starts[1]?.session?.instructions).not.toContain('dragon')
})

it('retains context updates during the handshake and excludes events from other sessions', async () => {
  const f = await fixture(false)
  const pending = f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  const append = (session: Session, text: string) => {
    const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    f.owner.emit('session/event', session, event)
  }
  append(f.other, 'Keep the other car blue.')
  append(f.session, 'Actually make our dragon green.')
  const context = new Promise<string>((resolve) => {
    socket.on('message', (raw) => {
      if (!Buffer.isBuffer(raw)) return
      const frame = JSON.parse(raw.toString('utf8')) as { type: string; content: string }
      if (frame.type === 'session.thinking.append') resolve(frame.content)
    })
  })
  socket.send(JSON.stringify({ type: 'session.started', session: { id: 'live' } }))
  await pending
  expect(await context).toContain('Actually make our dragon green.')
  expect(f.frames.some(frame => frame.content?.includes('other car'))).toBe(false)
  const nextUpdate = new Promise<string>((resolve) => {
    socket.once('message', (raw) => {
      if (!Buffer.isBuffer(raw)) throw new Error('Expected a text frame')
      const frame = JSON.parse(raw.toString('utf8')) as { content: string }
      resolve(frame.content)
    })
  })
  append(f.session, 'Add wings to our dragon.')
  expect(await nextUpdate).toContain('Add wings to our dragon.')
  const closed = once(socket, 'close')
  await f.owner.fiber.dispose()
  await closed
  const count = f.frames.length
  append(f.session, 'Do not send after disposal.')
  expect(f.frames).toHaveLength(count)
})


it('retains early delegation, suppresses its automatic acknowledgment, and journals actual acceptance', async () => {
  const f = await fixture()
  await f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'early', target: 'client' }, offset_ms: 1000 }))
  await expect.poll(() => f.frames.some(frame => frame.type === 'session.thinking.append' && frame.content === '')).toBe(true)
  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Highlight this area', start_ms: 500, end_ms: 1000 }))
  await f.entered.promise
  await expect.poll(() => f.frames.some(frame => frame.content?.includes('accepted the request into its inbox'))).toBe(true)
  const [name] = await readdir(f.diagnosticsDirectory)
  const records = (await readFile(join(f.diagnosticsDirectory, name!), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.filter(record => record.type === 'handoff').map(record => record.data.state)).toEqual(['received', 'waiting', 'dispatching', 'accepted'])
  expect(records.find(record => record.type === 'session.input_transcript.delta').data.delta).toBe('Highlight this area')
  expect(records.some(record => record.type === 'session.delegation.created')).toBe(true)
})
