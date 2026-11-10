/** Mechanics and acceptance tools run the host's own cheap stages first and bind every result to its revision. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizePlacement } from '../viewer/transform.js'
import { encodeStl } from '../viewer/stl.js'
import { createValidation } from '../viewer/validation.js'
import { registerValidationTools } from '../viewer/validation-tools.js'
import { summarizeValidationState } from '../viewer/validation-summary.js'
import { preserveMovement, validationState } from '../viewer/validation-state.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as mechanicalWorkflow from '../bullet/workflow.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const path = 'models/car/model.usda'
const intent = { assembly: { connections: [] }, motionKeys: ['door'], motionRanges: [{ key: 'door', range: [0, 90] }] }
const report = { version: 1, status: 'passed', checks: [], intent, printReady: false }
const mechanicalReport = { ...report, mechanics: { status: 'needs_repair', connections: [] } }
const mechanics = { version: 2, status: 'passed', assemblyVerified: true, coverage: { complete: true }, checks: [], connections: [], printReady: false }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rumi-validation-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new Context()
  cleanup.push(() => owner.fiber.dispose())
  const listeners = new Map<string, Function>()
  const ctx = { effect: owner.effect.bind(owner), on: (name: string, fn: Function) => listeners.set(name, fn),
    connection: { fetch: { register: () => () => {} } } }
  const run = vi.fn(async (_config, _input, _signal, stage) => ({ ...structuredClone(report),
    ...(stage === 'fit' ? { preparedGeometry: { bodies: [], assembly: intent.assembly } } : {}) }))
  const bullet = vi.fn(async () => structuredClone(mechanics))
  const config = { validation: {}, mechanics: {}, validationTimeoutMs: 1000, mechanicsTimeoutMs: 1000, validationStateDirectory: join(root, 'validation-state') }
  const options = { run, bullet, notify: () => {}, view: () => ({ selectedModel: null, volume: null, meshes: [] }) }
  const validation = createValidation(ctx, config, options)
  cleanup.push(() => validation.dispose())
  await mkdir(join(root, 'models/car'), { recursive: true })
  await writeFile(join(root, path), '#usda 1.0\n# revision 0\n')
  const call = (stage: string, args: object = { path }, signal = new AbortController().signal) => validation.execute('a', root, stage, args, signal)
  /** Scan the project through a stale acceptance and return the current revision's receipt. */
  const receipt = async () => {
    await call('accept', { path, fingerprint: 'unknown' })
    const { path: modelPath, fingerprint } = validation.read('a').models[0]
    return { path: modelPath, fingerprint }
  }
  return { root, ctx, config, options, validation, run, bullet, call, receipt, listeners }
}

it('never starts checks or repairs on project open or turn completion', async () => {
  const f = await fixture()
  await f.validation.restore('a', f.root, path)
  f.listeners.get('session/event')?.({ id: 'a', header: { cwd: f.root } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  expect(f.run).not.toHaveBeenCalled()
  expect(f.bullet).not.toHaveBeenCalled()
  expect(f.validation.requests('a')).toEqual([])
  expect(f.listeners.has('agent/status')).toBe(false)
})

it('runs missing cheap checks before Bullet, caches each stage and accepts the returned fingerprint', async () => {
  const f = await fixture(), receipt = await f.receipt()
  expect(await f.call('accept', receipt)).toMatchObject({ code: 'prerequisite_required' })
  expect(f.run).not.toHaveBeenCalled()
  expect(await f.call('mechanics')).toMatchObject({ path, fingerprint: receipt.fingerprint, stage: 'mechanics', status: 'passed', cached: false })
  expect(f.run.mock.calls.map(call => call[3])).toEqual(['assembly', 'geometry', 'fit'])
  expect(f.bullet).toHaveBeenCalledTimes(1)
  expect(await f.call('mechanics')).toMatchObject({ cached: true, fingerprint: receipt.fingerprint })
  expect(f.run).toHaveBeenCalledTimes(3)
  expect(f.bullet).toHaveBeenCalledTimes(1)
  expect(await f.call('accept', receipt)).toMatchObject({ status: 'accepted', printReady: false })
  expect(f.validation.presentation('a', path)).not.toBeNull()
})

it('restores accepted history without rechecking and retains it after a failed revision', async () => {
  const f = await fixture()
  const receipt = await f.receipt()
  await f.call('mechanics')
  await f.call('accept', receipt)
  const accepted = f.validation.presentation('a', path)
  await writeFile(join(f.root, path), '#usda 1.0\n# revision failed\n')
  f.run.mockImplementation(async () => ({ ...structuredClone(report), status: 'needs_repair', checks: [{ code: 'intersecting_faces', severity: 'error', count: 1 }] }))
  expect(await f.call('mechanics')).toMatchObject({ status: 'blocked', code: 'blocking_findings' })
  expect(f.validation.presentation('a', path).contentHash).toBe(accepted.contentHash)
  await f.validation.dispose()
  const restored = createValidation(f.ctx, f.config, f.options)
  cleanup.push(() => restored.dispose())
  const calls = f.run.mock.calls.length
  await restored.restore('a', f.root, path)
  expect(restored.presentation('a', path).contentHash).toBe(accepted.contentHash)
  expect(f.run).toHaveBeenCalledTimes(calls)
  expect(restored.read('a').models[0].completedStages).toEqual([])
})

it('rejects acceptance of earlier revisions and never reuses their reports', async () => {
  const f = await fixture(), receipt = await f.receipt()
  await f.call('mechanics')
  await writeFile(join(f.root, path), '#usda 1.0\n# revision 1\n')
  expect(await f.call('accept', receipt)).toMatchObject({ code: 'stale_revision' })
  const next = await f.receipt()
  expect(next.fingerprint).not.toBe(receipt.fingerprint)
  expect(f.validation.read('a').models[0].completedStages).toEqual([])
  expect(await f.call('accept', next)).toMatchObject({ code: 'prerequisite_required' })
  expect(f.bullet).toHaveBeenCalledTimes(1)
})

it('stops at the first blocking stage without Bullet, keeping findings and cached stages', async () => {
  const f = await fixture()
  const geometry = { ...structuredClone(report), status: 'needs_repair', checks: [{ code: 'intersecting_faces', severity: 'error', count: 2 }] }
  f.run.mockImplementation(async (_config, _input, _signal, stage) => stage === 'geometry' ? structuredClone(geometry) : structuredClone(report))
  const blocked = await f.call('mechanics')
  expect(blocked).toMatchObject({ path, stage: 'geometry', status: 'blocked', code: 'blocking_findings', bulletStarted: false })
  expect(blocked.fingerprint).toEqual(expect.any(String))
  expect(blocked.report.checks).toContainEqual({ code: 'intersecting_faces', severity: 'error', count: 2 })
  expect(f.run.mock.calls.map(call => call[3])).toEqual(['assembly', 'geometry'])
  expect(await f.call('mechanics')).toMatchObject({ stage: 'geometry', code: 'blocking_findings' })
  expect(f.run).toHaveBeenCalledTimes(2)
  expect(f.bullet).not.toHaveBeenCalled()
  expect(f.validation.read('a').models[0].report.checks).toContainEqual({ code: 'intersecting_faces', severity: 'error', count: 2 })
})

it('rejects stale results when source changes while a check runs', async () => {
  const f = await fixture()
  let finish!: (value: typeof report) => void
  f.run.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const pending = f.call('mechanics')
  await expect.poll(() => f.run.mock.calls.length).toBe(1)
  await writeFile(join(f.root, path), '#usda 1.0\n# revision 2\n')
  finish(structuredClone(report))
  expect(await pending).toMatchObject({ code: 'stale_revision' })
  expect(f.validation.read('a').models[0].completedStages).toEqual([])
})

it('cancels active work on disposal and waits for its settlement', async () => {
  const f = await fixture()
  f.run.mockImplementation((_config, _input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
  }))
  const pending = f.call('mechanics')
  const rejected = expect(pending).rejects.toThrow('Cancelled')
  await expect.poll(() => f.run.mock.calls.length).toBe(1)
  expect(await f.call('mechanics')).toMatchObject({ code: 'validation_busy' })
  await f.validation.dispose()
  await rejected
  expect(f.validation.read('a').models).toEqual([])
})

it('retains unavailable failures without treating them as completed stages', async () => {
  const f = await fixture()
  f.run.mockRejectedValue(new Error('Missing Blender'))
  await expect(f.call('mechanics')).rejects.toThrow('Missing Blender')
  expect(f.validation.read('a').models[0]).toMatchObject({ status: 'unavailable', completedStages: [], error: 'Missing Blender' })
})

it('preserves required movement across restart and blocks narrowed declarations', async () => {
  const f = await fixture()
  await f.call('mechanics')
  await f.validation.dispose()
  const next = createValidation(f.ctx, f.config, f.options)
  cleanup.push(() => next.dispose())
  f.run.mockImplementation(async () => ({ ...structuredClone(report), intent: { ...intent, motionRanges: [{ key: 'door', range: [0, 45] }] } }))
  await writeFile(join(f.root, path), '#usda 1.0\n# narrowed\n')
  const result = await next.execute('a', f.root, 'mechanics', { path }, new AbortController().signal)
  expect(result.report.checks).toContainEqual(expect.objectContaining({ code: 'required_movement_removed' }))
  expect(result).toMatchObject({ stage: 'assembly', status: 'blocked', code: 'blocking_findings' })
  expect(result.report.status).toBe('needs_repair')
})

it('fails closed on corrupt durable state', async () => {
  const f = await fixture(), receipt = await f.receipt()
  await f.call('mechanics')
  const [key] = await readdir(f.config.validationStateDirectory)
  await writeFile(join(f.config.validationStateDirectory, key!, 'state.json'), '{')
  await expect(f.call('mechanics')).resolves.toMatchObject({ cached: true })
  await expect(f.call('accept', receipt)).rejects.toThrow()
  expect(f.validation.presentation('a', path)).toBeNull()
})

it('does not accept incomplete mechanical coverage', async () => {
  const f = await fixture()
  f.bullet.mockResolvedValue({ ...mechanics, coverage: { complete: false } })
  const { fingerprint } = await f.call('mechanics')
  expect(await f.call('accept', { path, fingerprint })).toMatchObject({ code: 'mechanics_required' })
})

it('checks legacy renderer exports only through the tool and cancels pending requests', async () => {
  const f = await fixture(), legacy = { path: 'models/car/model.js' }
  await rm(join(f.root, path))
  await writeFile(join(f.root, legacy.path), 'export function build() {}')
  const abort = new AbortController()
  const pending = f.call('mechanics', legacy, abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await expect.poll(() => f.validation.requests('a').length).toBe(1)
  const request = f.validation.requests('a')[0]
  const bytes = new Uint8Array(encodeStl(new Float32Array([0,0,0,1,0,0,0,1,0])))
  expect(f.validation.submit('other', request.id, bytes, null)).toBe(false)
  expect(() => f.validation.submit('a', request.id, new Uint8Array(), null)).toThrow()
  abort.abort()
  await rejected
  expect(f.validation.submit('a', request.id, bytes, null)).toBe(false)
  const retry = f.call('mechanics', legacy)
  for (let stage = 0; stage < 3; stage++) {
    await expect.poll(() => f.validation.requests('a').length).toBe(1)
    f.validation.submit('a', f.validation.requests('a')[0].id, bytes, null)
  }
  expect(await retry).toMatchObject({ status: 'passed' })
})

it('discovers every model and invalidates printer or placement changes before acceptance', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'models/second'))
  await writeFile(join(f.root, 'models/second/model.usda'), '#usda 1.0\n# second model\n')
  const view = { selectedModel: path, transform: normalizePlacement(), sourceHash: '', volume: null, meshes: [] }
  const validator = createValidation(f.ctx, f.config, { ...f.options, view: () => view })
  cleanup.push(() => validator.dispose())
  const call = (stage: string, args: object) => validator.execute('b', f.root, stage, args, new AbortController().signal)
  const first = await call('mechanics', { path })
  expect(validator.read('b').models).toHaveLength(2)
  view.transform = normalizePlacement({ scale: 2 })
  expect(await call('accept', first)).toMatchObject({ code: 'stale_revision' })
  expect(f.bullet).toHaveBeenCalledTimes(1)
  const second = await call('mechanics', { path })
  expect(second.fingerprint).not.toBe(first.fingerprint)
  expect(f.bullet).toHaveBeenCalledTimes(2)
})

it('records explicit validation tools and their results within one agent turn', async () => {
  const f = await fixture(), ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(mechanicalWorkflow)
  const harness = await mountAgentLoopTestHarness(ctx)
  const receipt = await f.receipt()
  registerValidationTools(ctx, defineTool, f.validation, f.config)
  const adapter = new MockAdapter([
    toolCallResponse('mechanics', 'validation_mechanics', { path }),
    toolCallResponse('accept', 'validation_accept', { path, fingerprint: receipt.fingerprint }),
    textResponse('The checks passed for this revision.'),
  ])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const agent = await harness.create(SessionId('explicit-validation'), { provider: 'mock', model: 'mock' }, { cwd: f.root })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the car.' }] }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
  const recorded = events.flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [JSON.parse(block.text)] : []) : [])
  expect(recorded.map(value => ({
    stage: value.stage ?? value.status, status: value.status, printReady: value.printReady,
  }))).toMatchSnapshot()
  expect(recorded.at(-1)?.status).toBe('accepted')
  expect(adapter.requests[0]!.tools?.map(tool => tool.name).filter(name => name.startsWith('validation_')).sort())
    .toEqual(['validation_accept', 'validation_mechanics'])
  const prompt = adapter.requests[0]!.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : []))
    .find(line => line.startsWith('For multi-part or movable prints'))
  expect(prompt).toMatchSnapshot('explicit validation instructions')
  expect(events.filter(event => event.type === 'user/message' && String(event.data.source.kind) === 'print-validation')).toHaveLength(0)
})
it('preserves canonical control limits and connection travel across saved poses and restart', async () => {
  const f = await fixture()
  const state = validationState(join(f.root, 'required'), f.root, 'models/car/model.js')
  const intent = (range: number[], origin?: number) => ({ motionKeys: ['door'], motionRanges: [{ key: 'door', range, origin }],
    assembly: { connections: [{ id: 'hinge', kind: 'revolute', range }] } })
  const initial = preserveMovement({ movements: [] }, intent([0, 100], 0))
  await state.write(initial.required, null)
  const restarted = validationState(join(f.root, 'required'), f.root, 'models/car/model.js')
  const saved = await restarted.read()
  const changedPose = preserveMovement(saved.required, intent([-30, 70], 30))
  expect(changedPose.checks).toEqual([])
  expect(changedPose.required.movements).toContainEqual({ type: 'control', id: 'door', range: [0, 100], absolute: true })
  const reduced = preserveMovement(changedPose.required, intent([-30, 40], 30))
  expect(reduced.checks).toHaveLength(2)
  expect(preserveMovement(changedPose.required, intent([100, 200], 0)).checks).toHaveLength(1)
  expect(preserveMovement(changedPose.required, intent([-30, 70])).checks).toHaveLength(1)
  expect(preserveMovement(changedPose.required, { motionKeys: [], motionRanges: [], assembly: null }).checks).toHaveLength(2)
})

it('compacts successful probes without losing failures, coverage, policy or diagnostic data', () => {
  const full = { ...mechanicalReport, mechanics: { ...mechanicalReport.mechanics,
    policy: { maxTotalSteps: 2000000 }, coverage: { complete: false, connections: [] },
    connections: [{ id: 'wheel', probes: [
      ...Array.from({ length: 1000 }, () => ({ status: 'passed', kind: 'retention' })),
      { status: 'needs_repair', code: 'excessive_penetration', maxPenetrationMm: 0.23 },
      { status: 'review', code: 'probe_budget_exhausted' },
    ] }],
  } }
  const state = { models: [{ path: 'models/car/model.usda', status: 'changed', report: full, previousReport: full }] }
  const summary = summarizeValidationState(state)
  for (const report of [summary.models[0].report, summary.models[0].previousReport]) {
    expect(report.mechanics.coverage).toEqual(full.mechanics.coverage)
    expect(report.mechanics.policy).toEqual(full.mechanics.policy)
    expect(report.mechanics.connections[0]).toEqual({ id: 'wheel', probeCounts: { passed: 1000, needs_repair: 1, review: 1 },
      probes: full.mechanics.connections[0].probes.slice(-2) })
  }
  expect(full.mechanics.connections[0].probes).toHaveLength(1002)
  expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(state).length / 10)
})
