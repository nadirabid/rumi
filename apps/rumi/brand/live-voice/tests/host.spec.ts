/** Voice transports and pending starts belong to the plugin's Cordis lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'
import type { PrintBadgeEarned } from '../../print-studio/badges-event-types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.useRealTimers() }
})

async function fixture(acknowledge = true, config = {}, initiallyRunning = false) {
  const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'rumi-voice-journal-'))
  cleanups.push(() => rm(diagnosticsDirectory, { recursive: true, force: true }))
  const offered = deferred<undefined>()
  const respond = deferred<number>()
  if (acknowledge) respond.resolve(201)
  const offers: { session: { model: string; instructions: string }; transport: { type: string; sdp: string } }[] = []
  const authorizations: (string | undefined)[] = []
  const http = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization)
    let body = ''
    for await (const chunk of request) body += chunk
    offers.push(JSON.parse(body))
    offered.resolve(undefined)
    const status = offers.length === 1 ? await respond.promise : 201
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ session: { id: 'live_test' }, transport: { type: 'webrtc', sdp: 'test answer' } }))
  })
  http.listen(0, '127.0.0.1')
  const server = new WebSocketServer({ server: http })
  cleanups.push(async () => {
    respond.resolve(201)
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    http.closeAllConnections()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  await once(http, 'listening')
  const address = http.address()
  if (typeof address !== 'object' || address === null) throw new Error('Missing test address')
  const started = deferred<WebSocket>()
  const closeRequested = deferred<undefined>()
  let closeAcknowledgment: Promise<undefined> | undefined
  const holdProviderClose = () => {
    const acknowledgment = deferred<undefined>()
    closeAcknowledgment = acknowledgment.promise
    const release = () => acknowledgment.resolve(undefined)
    cleanups.push(async () => { release() })
    return { requested: closeRequested.promise, release }
  }
  server.on('connection', (socket, request) => {
    authorizations.push(request.headers.authorization)
    expect(request.url).toBe('/v1/live/sessions/live_test/attach')
    started.resolve(socket)
    socket.on('message', async (raw) => {
      if (!Buffer.isBuffer(raw)) throw new Error('Expected a text frame')
      const event: unknown = JSON.parse(raw.toString('utf8'))
      if (event === null || typeof event !== 'object' || !('type' in event)) return
      frames.push(event as { type: string; content?: string })
      if (event.type === 'session.close') {
        closeRequested.resolve(undefined)
        await closeAcknowledgment
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'session.closed' }))
      }
    })
  })
  const owner = new Context()
  cleanups.push(() => owner.fiber.dispose())
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let key = 'test-secret-value'
  const entered = deferred<undefined>()
  const idle = deferred<undefined>()
  cleanups.push(async () => { idle.resolve(undefined) })
  const injected: object[] = []
  const steered: object[] = []
  let flushed = false
  const session = new Session(SessionId('s'))
  const other = new Session(SessionId('other'))
  const projectPath = join(diagnosticsDirectory, 'projects', 'dragon')
  const otherProjectPath = join(diagnosticsDirectory, 'projects', 'car')
  owner.provide('rumiProjectScope', {
    rootFor(candidate: Session) {
      if (candidate === session) return projectPath
      if (candidate === other) return otherProjectPath
      throw new Error('Unknown project session')
    },
  })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Make the dragon red, with a handle.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  other.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Other conversation: a blue car.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const frames: { type: string; content?: string; event_id?: string }[] = []
  const ctx = {
    effect: owner.effect.bind(owner),
    inject: owner.inject.bind(owner),
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
      status: initiallyRunning ? 'running' : 'idle', session: id === 'other' ? other : session, inject: (message: object) => injected.push(message), steer: (message: object) => { steered.push(message); entered.resolve(undefined) }, whenIdle: () => idle.promise,
    } }) },
    sessions: { flush: async () => { flushed = true } },
  }
  // The JavaScript plugin consumes only these service methods; Cordis owns the effects.
  apply(ctx as Context, { ...config, diagnosticsDirectory, endpoint: `http://127.0.0.1:${address.port}/v1/live/sessions` })
  const request = (path: string, body?: object) => routes.get(`/api/live-voice${path}`)!(new Request(`http://rumi${path}`, {
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(path === '/session' ? { sdp: 'v=0 test offer', ...body } : body) : undefined,
  }))
  return { injected, steered, registry: owner.get('liveVoice'), diagnosticsDirectory, owner, session, other, projectPath, otherProjectPath, frames, offers, authorizations, request, started, offered, respond, holdProviderClose, entered, idle, flushed: () => flushed, key: () => key }
}

it('closes an established socket when its Cordis owner unloads', async () => {
  const f = await fixture()
  const response = await f.request('/session', { sessionId: 's' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ liveId: expect.any(String), sdp: 'test answer' })
  expect(f.offers[0]).toMatchObject({
    session: { model: 'gpt-live-1.1', delegation: { type: 'client' } },
    transport: { type: 'webrtc', sdp: 'v=0 test offer' },
  })
  const socket = await f.started.promise
  expect(f.authorizations).toEqual(['Bearer test-secret-value', 'Bearer test-secret-value'])
  expect(f.frames).toEqual([])
  const closed = once(socket, 'close')
  await f.owner.fiber.dispose()
  await closed
  expect(socket.readyState).toBe(3)
})

it('reserves voice across conversations during startup and aborts a handshake on unload', async () => {
  const f = await fixture(false)
  const pending = f.request('/session', { sessionId: 's' })
  await f.offered.promise
  const overlapping = await Promise.all([f.request('/session', { sessionId: 's' }), f.request('/session', { sessionId: 'other' })])
  for (const response of overlapping) {
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'voice_busy' })
  }
  await f.owner.fiber.dispose()
  expect((await pending).status).not.toBe(200)
  expect(f.authorizations).toEqual(['Bearer test-secret-value'])
})

it('keeps voice exclusive until the provider closes and ignores stale close IDs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  const closed = once(socket, 'close')

  const duplicate = await f.request('/session', { sessionId: 's' })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.json()).toMatchObject({ code: 'voice_busy' })
  const other = await f.request('/session', { sessionId: 'other' })
  expect(other.status).toBe(409)
  expect(await other.json()).toMatchObject({ code: 'voice_busy' })

  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Make a cube' }))
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'task' } }))
  await f.entered.promise
  const acknowledgment = f.holdProviderClose()
  const closing = f.request('/close', { liveId })
  await acknowledgment.requested
  expect(socket.readyState).toBe(socket.OPEN)
  const duringClose = await f.request('/session', { sessionId: 'other' })
  expect(duringClose.status).toBe(409)
  expect(await duringClose.json()).toMatchObject({ code: 'voice_busy' })
  expect(f.offers).toHaveLength(1)
  acknowledgment.release()
  expect((await closing).status).toBe(204)
  await closed

  const next = await f.request('/session', { sessionId: 'other' })
  expect(next.status).toBe(200)
  const { liveId: nextId } = await next.json()
  expect(nextId).not.toBe(liveId)
  expect((await f.request('/close', { liveId })).status).toBe(204)
  expect(await (await f.request('/poll', { liveId: nextId })).json()).toMatchObject({ closed: false })
  expect(f.offers).toHaveLength(2)
  expect(f.flushed()).toBe(false)
  f.idle.resolve(undefined)
})

it('shares new badge awards as silent context only with active voice for the owning project', async () => {
  const f = await fixture()
  type Award = PrintBadgeEarned['awards'][number]
  const award = (projectPath: string, id: string, kind: Award['kind'], path?: Award['path']) => f.owner.parallel('rumi/print-badge-earned', {
    projectId: brandString<PrintBadgeEarned['projectId']>(projectPath),
    projectPath,
    projectName: 'A project title never needed in voice context',
    awards: [{ id: brandString<Award['id']>(id), kind, ...(path ? { path } : {}) }],
  })
  await award(f.projectPath, 'older', 'barrel-hinge')
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  await award(f.otherProjectPath, 'elsewhere', 'gear-pair')
  await award(f.projectPath, 'new-award', 'dovetail-slide')
  await expect.poll(() => f.frames).toMatchObject([{
    type: 'session.thinking.append', event_id: expect.any(String), delegation_id: null,
    content: expect.stringContaining('The user just earned the Dovetail slide badge in this project.'),
  }])
  const note = f.frames[0]!
  expect(note.content).toContain('your next relevant reply')
  expect(note.content).not.toContain('project title')

  await award(f.projectPath, 'habit-award', 'patience', 'growth')
  await expect.poll(() => f.frames.length).toBe(2)
  const habitNote = f.frames[1]!
  expect(habitNote.content).toContain('The user just earned a Patience badge for improving in this project.')
  expect(habitNote.content).not.toContain('Print readiness requires a separate check.')

  const acknowledgment = f.holdProviderClose()
  const closing = f.request('/close', { liveId })
  await acknowledgment.requested
  await award(f.projectPath, 'after-stop', 'rack-and-pinion')
  acknowledgment.release()
  expect((await closing).status).toBe(204)
  expect(f.frames.map(frame => frame.type)).toEqual(['session.thinking.append', 'session.thinking.append', 'session.close'])
  expect(f.steered).toEqual([])
  expect(f.injected).toEqual([])

  const log = await readFile(join(f.diagnosticsDirectory, `${liveId}.jsonl`), 'utf8')
  expect(log.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'host.thinking')).toEqual([
    expect.objectContaining({ data: { delegationId: null, eventId: note.event_id, awardIds: ['new-award'], content: note.content } }),
    expect.objectContaining({ data: { delegationId: null, eventId: habitNote.event_id, awardIds: ['habit-award'], content: habitNote.content } }),
  ])
})

it('allows another conversation to start after the provider rejects an offer', async () => {
  const f = await fixture(false)
  const failed = f.request('/session', { sessionId: 's' })
  await f.offered.promise
  f.respond.resolve(503)
  expect((await failed).status).toBe(502)
  expect((await f.request('/session', { sessionId: 'other' })).status).toBe(200)
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


it('sends only the selected session history in the WebRTC session configuration', async () => {
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  expect(f.offers[0]?.session.instructions).toContain('Make the dragon red, with a handle.')
  expect(f.offers[0]?.session.instructions).not.toContain('blue car')
  await f.request('/close', { liveId })
  await f.request('/session', { sessionId: 'other' })
  expect(f.offers[1]?.session.instructions).toContain('Other conversation: a blue car.')
  expect(f.offers[1]?.session.instructions).not.toContain('dragon')
})

it('retains context updates during the handshake and excludes events from other sessions', async () => {
  const f = await fixture(false)
  const pending = f.request('/session', { sessionId: 's' })
  await f.offered.promise
  const append = (session: Session, text: string) => {
    const event = session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    f.owner.emit('session/event', session, event)
  }
  append(f.other, 'Keep the other car blue.')
  append(f.session, 'Actually make our dragon green.')
  f.respond.resolve(201)
  await pending
  const socket = await f.started.promise
  await expect.poll(() => f.frames.find(frame => frame.type === 'session.thinking.append')?.content)
    .toContain('Actually make our dragon green.')
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

it.each([
  ['whole ', 'part'],
  ['Can you show me ', 'that whole part?'],
])('delegates the spoken request with its original cursor reference (%s%s)', async (first, last) => {
  const f = await fixture()
  const content = [{ type: 'text', text: '{"selection":{"mode":"patch","partPath":["wheel"]}}' }]
  const captureRequest = vi.fn(async () => content)
  f.registry.register({
    id: 'selection-test',
    captureRequest,
  })
  await f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: first }))
  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: last }))
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'selection', target: 'client' } }))
  await f.entered.promise
  expect(captureRequest).toHaveBeenCalledExactlyOnceWith({
    sessionId: 's', requestedAt: expect.any(String), signal: expect.any(AbortSignal),
  })
  expect(f.steered).toEqual([expect.objectContaining({
    id: expect.any(String), source: { kind: 'user' }, content: [{ type: 'text', text: first + last }],
  })])
  expect(f.injected).toEqual([expect.objectContaining({
    content, source: expect.objectContaining({ kind: 'rumi-voice-reference', userMessageId: Reflect.get(f.steered[0]!, 'id') }),
  })])
})

it.each(['Probably just the back, let’s see', 'Yes, do it', 'Leave the crown alone'])(
  'sends the Live delegation policy and admits the follow-up %s unchanged', async (text) => {
    const f = await fixture()
    await f.request('/session', { sessionId: 's' })
    const instructions = f.offers[0]?.session.instructions
    expect(instructions).toContain('Delegate to the backend when:')
    expect(instructions).toContain('Do not delegate when:')
    expect(instructions).toContain('including short replies')
    const socket = await f.started.promise
    socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: text }))
    socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'follow-up', target: 'client' } }))
    await f.entered.promise
    expect(f.steered).toHaveLength(1)
    expect(JSON.stringify(f.steered)).toContain(text)
  },
)


it('closes after five minutes without user activity despite reflected silence, assistant text, and polling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  await f.request('/poll', { liveId })
  await vi.advanceTimersByTimeAsync(299_999)
  expect(socket.readyState).toBe(1)
  socket.send(JSON.stringify({ type: 'session.input_audio.append', audio: 'AAAA' }))
  socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' }))
  socket.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Rumi is ready.' }))
  const pong = once(socket, 'pong')
  socket.ping()
  await pong
  expect((await (await f.request('/poll', { liveId })).json()).events).toEqual([
    { type: 'transcript', role: 'assistant', text: 'Rumi is ready.' },
  ])
  const closed = once(socket, 'close')
  const poll = f.request('/poll', { liveId })
  await vi.advanceTimersByTimeAsync(1)
  const result = await (await poll).json()
  expect(result).toMatchInlineSnapshot(`
    {
      "closed": true,
      "events": [
        {
          "reason": "idle_timeout",
          "type": "closed",
        },
      ],
    }
  `)
  await closed
  expect(socket.readyState).toBe(3)
})

it.each(['speech', 'chat'])('restarts the configured user inactivity interval on %s', async (input) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture(true, { idleTimeoutMinutes: 3 })
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  await f.request('/poll', { liveId })
  await vi.advanceTimersByTimeAsync(179_999)
  if (input === 'speech') {
    const event = f.request('/poll', { liveId })
    socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello' }))
    await event
  } else {
    const message = createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })
    const event = f.session.append('user/message', message, { surfaceOp: 'append' })
    f.owner.emit('session/event', f.session, event)
  }
  await vi.advanceTimersByTimeAsync(179_999)
  expect(socket.readyState).toBe(1)
  const closed = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(1)
  await closed
})

it('lets a spoken reply play at the deadline without starting another five minutes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  await f.request('/poll', { liveId })
  await vi.advanceTimersByTimeAsync(299_999)
  const output = f.request('/poll', { liveId })
  socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: 'ABA=' }))
  expect((await (await output).json()).events).toEqual([{ type: 'speaking' }])
  await vi.advanceTimersByTimeAsync(4_999)
  expect(socket.readyState).toBe(1)
  const closed = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(1)
  await closed
})

it('waits for an already-running agent and ignores another conversation’s status', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture(true, {}, true)
  await f.request('/session', { sessionId: 's' })
  const socket = await f.started.promise
  f.owner.emit('api-session/status', SessionId('other'), false)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(socket.readyState).toBe(1)
  const closed = once(socket, 'close')
  f.owner.emit('api-session/status', SessionId('s'), false)
  await vi.advanceTimersByTimeAsync(1)
  await closed
})

it('keeps a delegated task open and gives its result time to play after the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Make a cube' }))
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'task' } }))
  await f.entered.promise
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(socket.readyState).toBe(1)
  await f.request('/poll', { liveId })
  const finished = f.request('/poll', { liveId })
  f.idle.resolve(undefined)
  expect((await (await finished).json()).events).toEqual([
    { type: 'transcript', role: 'assistant', text: 'That finished, with no output to report.' },
  ])
  await vi.advanceTimersByTimeAsync(4_999)
  expect(socket.readyState).toBe(1)
  const closed = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(1)
  await closed
})


it('suspends an idle countdown when typed work starts and removes timers on close', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const f = await fixture()
  const { liveId } = await (await f.request('/session', { sessionId: 's' })).json()
  const socket = await f.started.promise
  await vi.advanceTimersByTimeAsync(299_999)
  f.owner.emit('api-session/status', SessionId('s'), true)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(socket.readyState).toBe(1)
  f.owner.emit('api-session/status', SessionId('s'), false)
  const closed = once(socket, 'close')
  await f.request('/close', { liveId })
  await closed
  expect(vi.getTimerCount()).toBe(0)
  f.owner.emit('api-session/status', SessionId('s'), false)
  expect(vi.getTimerCount()).toBe(0)
})

it('stays quiet during a delegated turn without forwarding tool calls or in-flight messages', async () => {
  const f = await fixture()
  await f.request('/session', { sessionId: 's' })
  expect(f.offers[0]?.session.instructions).toContain('Stay silent while delegated work runs.')
  expect(f.offers[0]?.session.instructions).not.toContain('unless useful to the user')
  const socket = await f.started.promise

  socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Round the back of the helmet' }))
  socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'quiet-turn', target: 'client' } }))
  await f.entered.promise
  await expect.poll(() => f.frames.some(frame => frame.content?.includes('accepted the request into its inbox'))).toBe(true)

  f.session.append('turn/start', { turn: 1 })
  const echoedUser = f.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Round the back of the helmet' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  f.owner.emit('session/event', f.session, echoedUser)
  f.owner.emit('session/event', f.session, { type: 'tool/call', data: { name: 'bash' } } as never)
  f.owner.emit('session/event', f.session, { type: 'tool/call', data: { name: 'read_image' } } as never)
  const midAssistant = f.session.append('assistant/message', {
    turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'Checking the mesh now.' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  f.owner.emit('session/event', f.session, midAssistant)
  const finalAssistant = f.session.append('assistant/message', {
    turn: 1, step: 2, message: createAssistantMessage({ content: [{ type: 'text', text: 'The back is rounded now.' }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  f.owner.emit('session/event', f.session, finalAssistant)
  f.session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })

  f.idle.resolve(undefined)
  await expect.poll(() => f.frames.some(frame => frame.type === 'session.commentary.append')).toBe(true)

  expect(f.frames.map(frame => ({ type: frame.type, content: frame.content }))).toEqual([
    { type: 'session.thinking.append', content: '' },
    { type: 'session.thinking.append', content: expect.stringContaining('accepted the request into its inbox') },
    { type: 'session.commentary.append', content: 'The back is rounded now.' },
  ])
})
