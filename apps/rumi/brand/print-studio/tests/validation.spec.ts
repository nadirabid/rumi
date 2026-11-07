/** Turn completion validates source revisions independently of selection and tool use. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createValidation } from '../viewer/validation.js'
import { encodeStl } from '../viewer/stl.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const report = { version: 1, status: 'needs_repair', checks: [{ code: 'intersecting_faces', count: 2, severity: 'error' }], printReady: false }
async function fixture(run = vi.fn(async () => report), agent?: { status: string; followup: ReturnType<typeof vi.fn> }) {
  const root = await mkdtemp(join(tmpdir(), 'rumi-validation-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new Context()
  cleanup.push(() => owner.fiber.dispose())
  const routes = new Map()
  const listeners = new Map<string, Function>()
  const ctx = { agents: { get: () => agent }, effect: owner.effect.bind(owner), on: (name: string, fn: Function) => listeners.set(name, fn),
    connection: { fetch: { register: (spec: { path: string }) => {
      routes.set(spec.path, spec); return () => routes.delete(spec.path)
    } } } }
  const validation = createValidation(ctx, { validation: {}, validationRepairAttempts: 2 }, { createUserMessage, run, notify: () => {},
    view: () => ({ selectedModel: null, volume: null, meshes: [] }) })
  cleanup.push(() => validation.dispose())
  await mkdir(join(root, 'models/car'), { recursive: true })
  await writeFile(join(root, 'models/car/model.js'), 'export function build() {}')
  const emit = (type: string, data = { reason: { kind: 'completed' } }) => listeners.get('session/event')!({ id: 'a', header: { cwd: root } }, { type, data })
  const ready = async () => { await expect.poll(() => validation.requests('a').length).toBe(1); return validation.requests('a')[0] }
  const bytes = new Uint8Array(encodeStl(new Float32Array([0,0,0,1,0,0,0,1,0])))
  return { root, validation, run, emit, ready, bytes, routes }
}

it('runs after turn/end without a viewer_load, skips unchanged turns, and detects helper and parameter edits', async () => {
  const f = await fixture()
  f.emit('turn/start'); expect(f.validation.requests('a')).toEqual([])
  f.emit('turn/end'); let job = await f.ready()
  expect(f.validation.submit('a', job.id, f.bytes, null)).toBe(true)
  await expect.poll(() => f.validation.read('a').models[0]?.status).toBe('needs_repair')
  f.emit('turn/start'); expect(f.validation.read('a').models[0].report).toBeNull()
  f.emit('turn/end'); await expect.poll(() => f.validation.read('a').models[0].status).toBe('needs_repair')
  expect(f.run).toHaveBeenCalledTimes(1)
  for (const [file, text] of [['helper.js', 'export const x=1'], ['.rumi-parameters.json', '{"angle":20}']]) {
    f.emit('turn/start'); await writeFile(join(f.root, 'models/car', file), text); f.emit('turn/end')
    job = await f.ready(); f.validation.submit('a', job.id, f.bytes, null)
    await expect.poll(() => f.validation.read('a').models[0].status).toBe('needs_repair')
  }
  expect(f.run).toHaveBeenCalledTimes(3)
})

it('rejects old renderer requests and does not publish a late result over a new turn', async () => {
  let finish!: (value: typeof report) => void
  const run = vi.fn(() => new Promise<typeof report>((resolve) => { finish = resolve }))
  const f = await fixture(run)
  f.emit('turn/end'); const job = await f.ready(); f.validation.submit('a', job.id, f.bytes, null)
  await expect.poll(() => run.mock.calls.length).toBe(1)
  f.emit('turn/start')
  expect(f.validation.submit('a', job.id, f.bytes, null)).toBe(false)
  finish(report)
  await f.validation.dispose()
  expect(f.validation.read('a').models).toEqual([])
})

it('reports renderer and Blender failures without a passing result', async () => {
  const f = await fixture(vi.fn(async () => { throw new Error('Missing Blender') }))
  f.emit('turn/end'); let job = await f.ready()
  f.validation.submit('a', job.id, f.bytes, 'Build failed')
  expect(f.validation.read('a').models[0]).toMatchObject({ status: 'unavailable', report: null, error: 'Build failed' })
  f.emit('turn/end'); job = await f.ready(); f.validation.submit('a', job.id, f.bytes, null)
  await expect.poll(() => f.validation.read('a').models[0]?.error).toBe('Missing Blender')
})

it('keeps all discovered models independent of the selected preview and checks every source', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'models/second'))
  await writeFile(join(f.root, 'models/second/model.js'), 'export function build() {}')
  f.emit('turn/end')
  await expect.poll(() => f.validation.requests('a').length).toBe(2)
  for (const job of f.validation.requests('a')) f.validation.submit('a', job.id, f.bytes, null)
  await expect.poll(() => f.run.mock.calls.length).toBe(2)
})

it('rejects malformed geometry and cross-session submissions', async () => {
  const f = await fixture(); f.emit('turn/end'); const job = await f.ready()
  expect(f.validation.submit('b', job.id, f.bytes, null)).toBe(false)
  expect(() => f.validation.submit('a', job.id, new Uint8Array(), null)).toThrow()
  expect(f.run).not.toHaveBeenCalled()
})

it('records the automatic validation lifecycle for the next model request', async () => {
  const f = await fixture(); f.emit('turn/end'); const job = await f.ready()
  const pending = f.validation.read('a').models[0]
  f.validation.submit('a', job.id, f.bytes, null)
  await expect.poll(() => f.validation.read('a').models[0]?.status).toBe('needs_repair')
  expect({ pending: pending.status, result: f.validation.read('a').models[0].report }).toMatchInlineSnapshot(`
    {
      "pending": "awaiting_viewer",
      "result": {
        "checks": [
          {
            "code": "intersecting_faces",
            "count": 2,
            "severity": "error",
          },
        ],
        "printReady": false,
        "status": "needs_repair",
        "version": 1,
      },
    }
  `)
})

it('automatically queues one repair turn with durable findings and stops on unchanged geometry', async () => {
  const f = await fixture()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('Saved the car.'), textResponse('The intersections need repair.')])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const validator = createValidation({ agents: ctx.agents, on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx),
    connection: { fetch: { register: () => () => {} } } }, { validation: {}, validationRepairAttempts: 3 }, {
    createUserMessage, view: () => ({ selectedModel: null, volume: null, meshes: [] }), notify: () => {}, run: async () => report,
  })
  cleanup.push(() => validator.dispose())
  ctx.effect(() => ctx.systemPrompt.context({ name: 'validation-fixture', order: 210, required: true,
    text: ({ agent }) => {
      const item = agent && validator.read(agent.session.id).models[0]
      return JSON.stringify({ validation: item ? { status: item.status, report: item.report, previousReport: item.previousReport } : null })
    } }))
  const agent = await harness.create(SessionId('validation-session'), { provider: 'mock', model: 'mock' }, { cwd: f.root })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Create the car.' }] }))
  await agent.whenIdle()
  await expect.poll(() => validator.requests(agent.session.id).length).toBe(1)
  validator.submit(agent.session.id, validator.requests(agent.session.id)[0].id, f.bytes, null)
  await expect.poll(() => validator.read(agent.session.id).models[0].status).toBe('needs_repair')
  await expect.poll(() => agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBe(2)
  await agent.whenIdle()
  const contexts = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  expect(contexts.some(text => text.includes('intersecting_faces'))).toBe(true)
  expect(contexts).toMatchSnapshot()
  const repair = agent.session.snapshotEvents().find(event => event.type === 'user/message' && String(event.data.source.kind) === 'print-validation')
  expect(repair?.data.content).toMatchObject([{ type: 'text', text: expect.stringContaining('intersecting_faces') }])
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
})

it('checks GLB snapshots without a renderer and detects source changes during validation', async () => {
  let finish!: (value: typeof report) => void
  const run = vi.fn(() => new Promise<typeof report>((resolve) => { finish = resolve }))
  const f = await fixture(run)
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] })
  const body = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '))
  const glb = Buffer.alloc(20 + body.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(body.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); body.copy(glb, 20)
  await writeFile(join(f.root, 'models/car/model.glb'), glb)
  f.emit('turn/end')
  await expect.poll(() => run.mock.calls.length).toBe(1)
  expect(f.validation.requests('a')).toEqual([])
  const modified = Buffer.from(glb); modified[modified.length - 1] = 10
  await writeFile(join(f.root, 'models/car/model.glb'), modified)
  finish(report)
  await expect.poll(() => f.validation.read('a').models[0]?.status).toBe('changed')
  expect(f.validation.read('a').models[0]?.report).toBeNull()
})

it('bounds automatic repairs across changed revisions and respects cancelled turns', async () => {
  const agent = { status: 'idle', followup: vi.fn() }
  const f = await fixture(undefined, agent)
  async function edit(index: number, reason = 'completed') {
    f.emit('turn/start')
    await writeFile(join(f.root, 'models/car/model.js'), `export const revision = ${index}`)
    f.emit('turn/end', { reason: { kind: reason } })
    const request = await f.ready()
    f.validation.submit('a', request.id, f.bytes, null)
    await expect.poll(() => f.validation.read('a').models[0]?.status).toBe('needs_repair')
  }
  await edit(1, 'aborted')
  expect(agent.followup).not.toHaveBeenCalled()
  await edit(2)
  expect(agent.followup).toHaveBeenCalledTimes(1)
  await edit(3)
  expect(agent.followup).toHaveBeenCalledTimes(2)
  await edit(4)
  expect(agent.followup).toHaveBeenCalledTimes(2)
  expect(f.validation.read('a').models[0]?.report.status).toBe('needs_repair')
})

it('collects every model before sending one repair and does not repair unavailable checks', async () => {
  const agent = { status: 'idle', followup: vi.fn() }
  const f = await fixture(undefined, agent)
  await mkdir(join(f.root, 'models/second'))
  await writeFile(join(f.root, 'models/second/model.js'), 'export function build() {}')
  f.emit('turn/end')
  await expect.poll(() => f.validation.requests('a').length).toBe(2)
  const [first, second] = f.validation.requests('a')
  f.validation.submit('a', first.id, f.bytes, null)
  await expect.poll(() => f.validation.read('a').models.some(item => item.status === 'needs_repair')).toBe(true)
  expect(agent.followup).not.toHaveBeenCalled()
  f.validation.submit('a', second.id, f.bytes, null)
  await expect.poll(() => agent.followup.mock.calls.length).toBe(1)
  const message = agent.followup.mock.calls[0][0]
  expect(message.source.kind).toBe('print-validation')
  expect(message.content[0].text.replaceAll(/"fingerprint":"[a-f0-9]+"/g, '"fingerprint":"<revision>"')).toMatchSnapshot()
  const failed = await fixture(vi.fn(async () => { throw new Error('Missing Blender') }), agent)
  failed.emit('turn/end')
  const request = await failed.ready()
  failed.validation.submit('a', request.id, failed.bytes, null)
  await expect.poll(() => failed.validation.read('a').models[0]?.status).toBe('unavailable')
  expect(agent.followup).toHaveBeenCalledTimes(1)
})
