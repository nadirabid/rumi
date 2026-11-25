/** Durable project awards across edited models, retries and host restarts. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { createProjectStore } from '../../projects/index.js'
import { createBadgeHost } from '../badges-host.js'
import { openBadgeStore } from '../badges-store.js'
import type { PrintBadgeEarned } from '../badges-event-types.d.ts'
import { BadgeReviewConfig, reviewPrintBadges } from '../badge-review.js'
import { capturePrintBadgeRevisions } from '../badge-review-evidence.js'
import { foldedPanels } from './fixtures/badge-fold.ts'

type Event = { type: string; seq: number; data: Record<string, unknown> }
type Session = { id: string; header: { id: string; cwd: string } }
type Input = { session: Session; signal: AbortSignal; targets: { modelPath: string; changed: boolean }[]; events: Event[]; recordRequest: (record: object) => Promise<void> }
const disposers: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })
const subscribeRequest = (signal?: AbortSignal) => new Request('http://localhost/api/print-studio/badges/events', { signal })

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rumi-badges-')))
  disposers.push(() => rmSync(home, { recursive: true, force: true }))
  const workspace = join(home, 'workspace')
  const modelPath = 'models/gearbox/model.usda'
  const databasePath = join(home, 'print-studio', 'badges.sqlite')
  const logs = new Map<string, { session: Session; history: Event[] }>()
  let listener: (session: Session, event: Event) => void
  function createProject(name: string) {
    const projectId = randomUUID()
    const project = join(workspace, projectId)
    mkdirSync(join(project, 'models', 'gearbox'), { recursive: true })
    const id = randomUUID()
    const session: Session = { id, header: { cwd: project, id } }
    const history: Event[] = []
    logs.set(id, { session, history })
    const metadata = (sessionIds: string[]) => writeFileSync(join(project, 'project.json'), JSON.stringify({ id: projectId, name, type: 'print', sessionIds }))
    metadata([id])
    let turn = 0
    const emit = (type: string, fields: Record<string, unknown> = {}) => {
      if (type === 'turn/start') turn++
      const event = { type, seq: history.length, data: { turn, ...fields } }
      history.push(event)
      listener(session, event)
    }
    const finish = (kind = 'completed') => emit('turn/end', { reason: { kind } })
    const edit = (data = randomUUID()) => writeFileSync(join(project, modelPath), data)
    return { finish, edit, emit, metadata, history, projectId, project, session, modelPath }
  }
  const main = createProject('Gearbox')
  const start = (review: (input: Input) => Promise<object[]>, onAward: (event: PrintBadgeEarned) => void = () => {}) => {
    let dispose: (() => Promise<void>) | undefined
    const ctx = {
      rumiProjectScope: { workspaceRoot: workspace }, logger: { warn: vi.fn() },
      sessionQuery: { observeSession: async (id: string) => {
        const log = logs.get(id)
        if (!log) throw new Error('Fixture session is missing')
        return { header: log.session.header, inheritedEventCount: 0, events: log.history.slice(), [Symbol.dispose]() {} }
      } },
      on(_type: string, handle: typeof listener) { listener = handle },
      async parallel(_type: 'rumi/print-badge-earned', event: PrintBadgeEarned) { onAward(event) },
      effect(effect: () => () => Promise<void>) { dispose = effect() },
    }
    const host = createBadgeHost(ctx, { databasePath, config: {}, capture: capturePrintBadgeRevisions, review: (_ctx: object, input: Input) => review(input) })
    const stop = async () => { const run = dispose; dispose = undefined; await run?.() }
    disposers.push(stop)
    return { ...host, stop }
  }
  const award = (working = false, revision = 'revision1') => ({ kind: 'gear-pair', modelPath, sourceHash: 'a'.repeat(64), working, revision, evidence: 'Two gears mesh.', evidenceRefs: ['observation:1'] })
  return { ...main, start, createProject, award, databasePath }
}

it('awards a changed revision once per project and promotes it only with later working evidence', async () => {
  const f = fixture()
  const review = vi.fn(async (input: Input) => {
    await input.recordRequest({ prompt: 'Exact independent request' })
    return [f.award(!input.targets[0]!.changed, String(input.events.at(-1)!.seq))]
  })
  const announcements: PrintBadgeEarned[] = []
  const host = f.start(review, event => {
    const inspection = new DatabaseSync(f.databasePath, { readOnly: true })
    try {
      const stored = inspection.prepare('SELECT id FROM awards WHERE projectId=? AND kind=?').get(f.projectId, 'gear-pair')
      expect(stored?.id).toBe(event.awards[0]?.id)
      announcements.push(event)
    } finally { inspection.close() }
  })
  const stream = host.subscribe(subscribeRequest())
  expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
  f.emit('turn/start'); f.edit(); f.finish()
  await host.whenIdle()
  const first = host.collection(null).awards[0]
  expect(first).toMatchObject({ projectId: f.projectId, projectName: 'Gearbox', working: false })
  f.emit('turn/start'); f.finish()
  f.emit('turn/start'); f.edit(); f.finish('aborted')
  await host.whenIdle()
  expect(review).toHaveBeenCalledTimes(1)
  f.emit('turn/start'); f.emit('tool/call', { name: 'validation_mechanics', arguments: JSON.stringify({ path: f.modelPath }) }); f.finish()
  await host.whenIdle()
  expect(host.collection(f.projectId)).toMatchObject({ awards: [{ id: first.id, earnedAt: first.earnedAt, working: true }], pending: 0, failed: 0 })
  f.emit('turn/start'); f.emit('tool/ptc-dispatch', { turn: undefined, name: 'validation_mechanics', arguments: { path: f.modelPath } }); f.finish()
  await host.whenIdle()
  expect(review).toHaveBeenCalledTimes(3)
  expect(host.collection(null).awards[0]?.id).toBe(first.id)
  expect(announcements).toEqual([{
    projectId: f.projectId, projectPath: f.project, projectName: 'Gearbox', awards: [{ id: first.id, kind: 'gear-pair' }],
  }])
  const inspection = new DatabaseSync(f.databasePath, { readOnly: true })
  try { expect(inspection.prepare('SELECT count(*) AS total FROM requests').get()?.total).toBe(3) } finally { inspection.close() }
  expect(host.collection(randomUUID()).awards).toEqual([])
  f.metadata([])
  expect(host.collection(null).awards).toEqual([])
  const lateSubscriber = host.subscribe(subscribeRequest())
  await host.stop()
  expect(await lateSubscriber.text()).toBe(': connected\n\n')
  expect(await stream.text()).toBe(
    `: connected\n\nevent: badge-earned\ndata: ${JSON.stringify({ projectId: f.projectId, projectName: 'Gearbox', awards: [{ id: first.id, kind: 'gear-pair' }] })}\n\n`,
  )
})

it('keeps a failed review retryable after restarting and rejects unregistered sessions', async () => {
  const f = fixture()
  const host = f.start(async () => { throw new Error('provider unavailable') })
  f.metadata([]); f.emit('turn/start'); f.edit(); f.finish()
  await host.whenIdle()
  expect(host.collection(null)).toEqual({ awards: [], pending: 0, failed: 0 })
  f.metadata([f.session.id]); f.emit('turn/start'); f.edit(); f.finish()
  await host.whenIdle()
  expect(host.collection(null).failed).toBe(1)
  await host.stop()
  const restored = f.start(async () => [f.award()])
  expect(restored.retry(null)).toEqual({ queued: 1 })
  expect(restored.retry(null)).toEqual({ queued: 0 })
  await restored.whenIdle()
  expect(restored.collection(null).awards).toHaveLength(1)
})

it('drains late evaluation after disposal and replays its exact turn on restart', async () => {
  const f = fixture()
  const started = Promise.withResolvers<Input>()
  const release = Promise.withResolvers<void>()
  const active = f.start(async input => { started.resolve(input); await release.promise; return [f.award()] })
  f.emit('turn/start'); f.edit(); f.finish()
  const input = await started.promise
  const stopping = active.stop()
  try { expect(input.signal.aborted).toBe(true) } finally { release.resolve() }
  await stopping
  const check = vi.fn(async () => [f.award()])
  const restored = f.start(check)
  await restored.whenIdle()
  expect(check).toHaveBeenCalledOnce()
  expect(restored.collection(null).awards).toHaveLength(1)
})

it('serializes claims across stores for one project and allows a different project to claim a turn', () => {
  const f = fixture()
  const first = openBadgeStore(f.databasePath)
  disposers.push(() => first.close())
  const second = openBadgeStore(f.databasePath)
  disposers.push(() => second.close())
  const separate = f.createProject('Second project')
  first.enqueue(f.projectId, f.session.id, 1, [])
  second.enqueue(f.projectId, f.session.id, 1, [])
  const job = first.take(f.projectId)
  second.enqueue(f.projectId, randomUUID(), 2, [])
  expect(second.take(f.projectId)).toBeNull()
  second.enqueue(separate.projectId, separate.session.id, 2, [])
  const other = second.take(separate.projectId)
  second.commit(other, [])
  expect(() => second.commit(job, [f.award(false)])).toThrow('Badge review ownership changed')
  expect(first.awards()).toEqual([])
  expect(first.commit(job, [f.award(false)])).toMatchObject([{ kind: 'gear-pair' }])
  const next = second.take(f.projectId)
  expect(second.commit(next, [f.award(true)])).toEqual([])
  first.enqueue(f.projectId, f.session.id, 3, [])
  const later = first.take(f.projectId)
  first.commit(later, [f.award(false)])
  expect(first.awards()).toMatchObject([{ working: true, turnEndSeq: 2 }])
})

it('closes an aborted badge subscription and keeps other clients subscribed', async () => {
  const f = fixture()
  const host = f.start(async () => [f.award()])
  const aborted = new AbortController()
  const reader = host.subscribe(subscribeRequest(aborted.signal)).body!.getReader()
  expect(await reader.read()).toMatchObject({ done: false })
  aborted.abort()
  expect(await reader.read()).toEqual({ done: true, value: undefined })
  const cancelled = host.subscribe(subscribeRequest())
  await cancelled.body!.cancel()
  const remaining = host.subscribe(subscribeRequest())
  f.emit('turn/start'); f.edit(); f.finish()
  await host.whenIdle()
  await host.stop()
  expect(await remaining.text()).toContain('\nevent: badge-earned\n')
})

it('keeps a batch of committed awards when an announcement listener fails', async () => {
  const f = fixture()
  const unavailable = vi.fn(() => { throw new Error('unavailable receiver') })
  const host = f.start(async () => [f.award(), { ...f.award(), kind: 'living-hinge' }], unavailable)
  const stream = host.subscribe(subscribeRequest())
  f.emit('turn/start'); f.edit(); f.finish()
  await host.whenIdle()
  expect(host.collection(f.projectId)).toMatchObject({
    awards: expect.arrayContaining([{ kind: 'gear-pair' }, { kind: 'living-hinge' }].map(award => expect.objectContaining(award))),
    failed: 0,
    pending: 0,
  })
  expect(unavailable).toHaveBeenCalledOnce()
  await host.stop()
  const frames = (await stream.text()).match(/^data: (.+)$/gm)
  expect(frames).toHaveLength(1)
  expect(JSON.parse(frames![0]!.slice('data: '.length)).awards.map((award: { kind: string }) => award.kind)).toEqual(['gear-pair', 'living-hinge'])
})

it('finishes a badge review in another project while remaining turns in the busy project wait', async () => {
  const f = fixture()
  const other = f.createProject('Slide')
  const primaryStarted = Promise.withResolvers<void>()
  const releasePrimary = Promise.withResolvers<void>()
  const host = f.start(async input => {
    if (input.session.id === f.session.id && input.events.at(-1)?.seq === 1) {
      primaryStarted.resolve()
      await releasePrimary.promise
    }
    return [f.award()]
  })
  try {
    f.emit('turn/start'); f.edit(); f.finish()
    await primaryStarted.promise
    f.emit('turn/start'); f.edit(); f.finish()
    other.emit('turn/start'); other.edit(); other.finish()
    await host.whenIdle(other.projectId)
    expect(host.collection(f.projectId)).toMatchObject({ awards: [], pending: 2, failed: 0 })
    expect(host.collection(other.projectId)).toMatchObject({ awards: [{ projectId: other.projectId }], pending: 0, failed: 0 })
  } finally { releasePrimary.resolve() }
  await host.whenIdle()
  expect(host.collection(null)).toMatchObject({ pending: 0, failed: 0 })
  expect(host.collection(null).awards.map(award => award.projectId).sort()).toEqual([f.projectId, other.projectId].sort())
})

it('records a custom fold from a finished project turn and keeps the badge review outside the next prompt', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rumi-badge-session-')))
  disposers.push(() => rmSync(home, { recursive: true, force: true }))
  const workspaceRoot = join(home, 'workspace')
  const projects = createProjectStore(workspaceRoot)
  const project = await projects.create('Folded card', { type: 'print' })
  const modelPath = 'models/card/model.usda'
  const revision = 'a'.repeat(32)
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  ctx.provide('rumiProjectScope', { workspaceRoot })
  const harness = await mountAgentLoopTestHarness(ctx)
  const host = createBadgeHost(ctx, { databasePath: join(home, 'print-studio', 'badges.sqlite'),
    config: BadgeReviewConfig({}), capture: capturePrintBadgeRevisions, review: reviewPrintBadges })
  const announced: string[] = []
  ctx.on('rumi/print-badge-earned', ({ awards }) => { announced.push(...awards.map(award => award.kind)) })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'save_model', description: 'Save the requested model revision.', parameters: {},
    async execute() {
      const current = join(project.path, modelPath)
      const saved = join(dirname(current), 'revisions', revision, 'model.usda')
      mkdirSync(dirname(saved), { recursive: true })
      const usd = foldedPanels()
      writeFileSync(saved, usd)
      writeFileSync(current, usd)
      return [{ type: 'text', text: 'Saved the folded card.' }]
    },
  })))
  const primary = new MockAdapter([toolCallResponse('save-card', 'save_model', {}), textResponse('Saved the card.'), textResponse('It has two panels.')])
  const reviewer = new MockAdapter([textResponse(JSON.stringify({ findings: [{ kind: 'living-hinge', parts: ['part:0'],
    refs: ['section:part:0:y'], evidence: 'A thin strip joins the two thicker panels.' }], inspect: [] }))],
    { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], primary))
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], reviewer))
  const sessionId = SessionId('badge-fold-session')
  const agent = await harness.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: project.path })
  await projects.attachSession(project.id, sessionId)
  const send = async (text: string) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await agent.whenIdle()
    await host.whenIdle()
  }
  await send('Make a folding card with a thin strip between the panels.')
  const earned = host.collection(project.id).awards[0]
  expect(earned).toMatchObject({ kind: 'living-hinge', projectName: 'Folded card', modelPath, revision })
  await send('How many panels are there?')
  expect(host.collection(null).awards).toEqual([earned])
  expect(primary.requests).toHaveLength(3)
  const primaryInputs = primary.requests.map(({ purpose, system, messages }) => ({ purpose, system, messages }))
  expect(JSON.stringify(primaryInputs)).not.toMatch(/rumi-print-badge-review|Identify mechanical features on one saved|section:part:0:y|A thin strip joins the two thicker panels/)
  expect(reviewer.requests.map(request => request.purpose)).toEqual(['rumi-print-badge-review'])
  using observed = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  const turns = observed.events.filter(event => event.type === 'turn/end')
  expect(earned?.turnEndSeq).toBe(turns[0]?.seq)
  expect({ turns: turns.map(event => event.data.reason.kind), badge: earned?.kind, announced, working: earned?.working,
    evidence: earned?.evidence, projects: host.collection(null).awards.map(item => item.projectName) }).toMatchInlineSnapshot(`
    {
      "announced": [
        "living-hinge",
      ],
      "badge": "living-hinge",
      "evidence": "A thin strip joins the two thicker panels.",
      "projects": [
        "Folded card",
      ],
      "turns": [
        "completed",
        "completed",
      ],
      "working": false,
    }
  `)
})
