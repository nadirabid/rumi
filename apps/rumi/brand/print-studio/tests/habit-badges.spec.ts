/** Verify deterministic habit badge signals, evaluator validation, v1->v2 migration, and host queueing. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { extractHabitBadgeEvidence } from '../badge-review-habit-evidence.js'
import { reviewHabitBadges } from '../badge-review-habits.js'
import { createBadgeReviewConfig } from '../badge-review.js'
import { capturePrintBadgeRevisions } from '../badge-review-evidence.js'
import { createBadgeHost } from '../badges-host.js'
import { openBadgeStore } from '../badges-store.js'
import type { PrintBadgeEarned } from '../badges-event-types.d.ts'

type Event = { type: string; seq: number; time?: number; data: Record<string, unknown> }
const roots: string[] = []
const disposers: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix = 'rumi-habit-badges-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

function buildLog() {
  const events: Event[] = []
  let now = 1_700_000_000_000
  let turn = 0
  const push = (type: string, data: Record<string, unknown>, advanceMs = 500) => {
    now += advanceMs
    const event: Event = { type, seq: events.length, time: now, data }
    events.push(event)
    return event
  }
  return {
    events,
    advance(ms: number) { now += ms },
    startTurn() { turn += 1; return push('turn/start', { turn }, 1000) },
    user(text: string, id = randomUUID(), advanceMs = 200) {
      return push('user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, advanceMs)
    },
    voiceRef(userMessageId: string) {
      return push('user/message', {
        id: randomUUID(), role: 'user',
        source: { kind: 'rumi-voice-reference', form: 'notice', summary: 'Pointing reference', userMessageId },
        content: [{ type: 'text', text: 'Pointing at lid' }],
      }, 100)
    },
    runtimeContext(text: string) {
      return push('user/message', { id: randomUUID(), role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }, 100)
    },
    stepStart(step = 1) { return push('step/start', { turn, step }, 100) },
    stepEnd(step = 1) { return push('step/end', { turn, step }, 100) },
    toolCall(callId: string, name: string, args: object = {}, step = 1) {
      return push('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) }, 200)
    },
    toolResult(callId: string, text: string, { isError = false, step = 1, advanceMs = 1000 } = {}) {
      return push('tool/result', {
        turn, step, message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text }] },
      }, advanceMs)
    },
    assistant(text: string, { interrupted = false, step = 1 } = {}) {
      return push('assistant/message', {
        turn, step, ...(interrupted ? { interrupted: true } : {}),
        message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [],
      }, 300)
    },
    endTurn(reason: Record<string, unknown> = { kind: 'completed' }) {
      return push('turn/end', { turn, reason }, 200)
    },
  }
}

function modelReceipt(revision: string) {
  return `RUMI_MODEL ${JSON.stringify({
    preview: 'models/box/model.usda',
    revisionUsd: `models/box/revisions/${revision}/model.usda`,
  })}\n`
}

it('detects Patience practice streaks, voice completion grace window, and recovery growth', () => {
  const project = tempDir()
  const log = buildLog()

  // Turn 1: user interrupts mid-step after a tool result -> earlier interruption.
  log.startTurn()
  log.user('Make a box')
  log.stepStart(1)
  log.toolCall('c1', 'bash', { command: 'build' })
  log.toolResult('c1', 'ok', { advanceMs: 8_000 })
  log.user('Actually make it taller right now', randomUUID(), 2_000)
  log.assistant('Updating now.')
  log.endTurn()

  // Turn 2: clean heavy turn with a Live Voice sentence completion within 4s before any tool result -> NOT a steer.
  log.startTurn()
  const voiceId = randomUUID()
  log.voiceRef(voiceId)
  log.user('Add a rounded lid on top', voiceId, 200)
  log.stepStart(1)
  log.user('with a small lip around the edge', randomUUID(), 2_000)
  log.toolCall('c2', 'bash', { command: 'build' })
  log.toolResult('c2', modelReceipt('1'.repeat(32)), { advanceMs: 18_000 })
  log.toolCall('c3', 'viewer_load', {})
  log.toolResult('c3', 'loaded')
  log.assistant('Added the rounded lid.')
  log.endTurn()

  // Turn 3: second clean substantive turn -> triggers Patience growth path (2 clean after earlier interrupt).
  log.startTurn()
  log.user('The lid looks great, make the walls 3 mm thick.')
  log.stepStart(1)
  log.toolCall('c4', 'bash', { command: 'build' })
  log.toolResult('c4', modelReceipt('2'.repeat(32)), { advanceMs: 5_000 })
  log.assistant('Walls are now 3 mm thick.')
  log.endTurn()

  const growth = extractHabitBadgeEvidence(project, log.events, ['language', 'patience', 'persistence'])
  expect(growth.patience).toMatchObject({
    eligible: true,
    practiceEligible: false,
    growthEligible: true,
    cleanSubstantiveStreak: 2,
    streakTurnRefs: ['turn:2', 'turn:3'],
    earlierInterruptionTurnRefs: ['turn:1'],
  })
  expect(growth.facts.messages.find(m => m.text.includes('rounded lid'))?.pointedAtModel).toBe(true)

  // Turn 4: third consecutive clean substantive turn -> also unlocks practiceEligible.
  log.startTurn()
  log.user('Add a chamfer to the bottom edge.')
  log.stepStart(1)
  log.toolCall('c5', 'bash', { command: 'build' })
  log.toolResult('c5', modelReceipt('3'.repeat(32)), { advanceMs: 5_000 })
  log.assistant('Added bottom chamfer.')
  log.endTurn()

  const practice = extractHabitBadgeEvidence(project, log.events, ['patience'])
  expect(practice.patience.practiceEligible).toBe(true)
  expect(practice.patience.cleanSubstantiveStreak).toBe(3)
})

it('distinguishes cross-turn setbacks and stopping points from agent-only retries or unresolved errors', () => {
  const project = tempDir()
  const log = buildLog()

  // Turn 1: agent hits an error but fixes it inside the SAME turn -> NOT a cross-turn setback.
  log.startTurn()
  log.user('Build a hinged clip')
  log.stepStart(1)
  log.toolCall('a1', 'bash')
  log.toolResult('a1', '[exit code: 1] syntax error', { isError: true })
  log.toolCall('a2', 'bash')
  log.toolResult('a2', modelReceipt('a'.repeat(32)))
  log.assistant('Built the clip.')
  log.endTurn()

  const afterOne = extractHabitBadgeEvidence(project, log.events, ['persistence'])
  expect(afterOne.persistence.crossTurnSetbacks).toEqual([])
  expect(afterOne.eligibleKinds).toEqual([])

  // Turn 2: ends with a blocking geometry check -> cross-turn setback once user responds.
  log.startTurn()
  log.user('Make the clip arm thinner')
  log.stepStart(1)
  log.toolCall('a3', 'bash')
  log.toolResult('a3', `${modelReceipt('b'.repeat(32))}RUMI_CHECKS ${JSON.stringify({ ok: false, blocking: ['thin wall'] })}\n`)
  log.assistant('The wall is too thin to print cleanly.')
  log.endTurn()

  // Still unresolved on latest turn -> persistence ineligible.
  expect(extractHabitBadgeEvidence(project, log.events, ['persistence']).eligibleKinds).toEqual([])

  // Turn 3: user responds to fix it, validation_accept passes.
  log.startTurn()
  log.user('Thicken the clip arm back to 2.5 mm and check it again.')
  log.stepStart(1)
  log.toolCall('a4', 'bash')
  log.toolResult('a4', modelReceipt('c'.repeat(32)))
  log.toolCall('a5', 'validation_accept')
  log.toolResult('a5', JSON.stringify({ accepted: true }))
  log.assistant('The revised clip passed validation.')
  log.endTurn()

  // Also simulate a saved print handoff receipt on disk.
  writeFileSync(join(project, '.rumi-print-handoff.json'), JSON.stringify({
    model: 'models/box/model.usda', sourceHash: 'f'.repeat(64), openedAt: '2026-11-27T00:00:00.000Z',
  }))

  const settled = extractHabitBadgeEvidence(project, log.events, ['persistence'])
  expect(settled.persistence.eligible).toBe(true)
  expect(settled.persistence.crossTurnSetbacks).toHaveLength(1)
  expect(settled.persistence.stoppingPoints.map(point => point.kind)).toEqual(['validation-accepted', 'print-handoff'])
})

it('validates evaluator citations, sanitizes leaked ref IDs, and skips model calls when ineligible', async () => {
  const project = tempDir()
  const log = buildLog()
  log.startTurn()
  log.user('Hi Rumi')
  log.assistant('Hello!')
  log.endTurn()

  const prepareCall = vi.fn()
  const config = createBadgeReviewConfig(z)({})
  const records: object[] = []

  // Single short turn -> zero LLM calls.
  await expect(reviewHabitBadges({ llm: { prepareCall } }, {
    session: { id: 's1' }, project: { path: project }, turnEndSeq: log.events.at(-1)!.seq,
    events: log.events, unearnedKinds: ['language', 'patience', 'persistence'],
    signal: new AbortController().signal, recordRequest: async record => { records.push(record) },
  }, config)).resolves.toEqual([])
  expect(prepareCall).not.toHaveBeenCalled()
  expect(records).toEqual([])

  // Add second clear human turn (and a private line that must be redacted from evaluator input).
  log.startTurn()
  log.runtimeContext('internal system data')
  const second = log.user('Make the lid 45 mm wide with a 3 mm snap lip.\nmy api_key is secret123')
  log.assistant('Updated the lid to 45 mm with a snap lip.')
  log.endTurn()

  const firstMsg = log.events.find(e => e.type === 'user/message' && (e.data.source as { kind?: string })?.kind === 'user')!
  const mockPrepare = vi.fn(async (cfg: object) => ({
    config: cfg,
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const payload = JSON.parse((options.messages[0]?.content[0] as { text: string }).text)
      expect(JSON.stringify(payload)).not.toContain('secret123')
      expect(payload.candidateKinds).toEqual(['language'])
      yield {
        type: 'text-delta', index: 0, text: JSON.stringify({
          findings: [
            // Invalid ref -> dropped.
            { kind: 'patience', path: 'practice', signals: ['P1'], refs: ['turn:99', 'turn:1'], evidence: 'Waited.' },
            // Valid language finding, but leaks internal msg: ref -> sanitized to plain child-safe text.
            { kind: 'language', path: 'growth', signals: ['L2', 'L5'], refs: [`msg:${firstMsg.seq}`, `msg:${second.seq}`],
              evidence: 'In msg:4 the user gave exact lid dimensions.' },
          ],
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }))

  const awards = await reviewHabitBadges({ llm: { prepareCall: mockPrepare } }, {
    session: { id: 's1' }, project: { path: project }, turnEndSeq: log.events.at(-1)!.seq,
    events: log.events, unearnedKinds: ['language', 'patience', 'persistence'],
    signal: new AbortController().signal, recordRequest: async record => { records.push(record) },
  }, config)

  expect(awards).toEqual([{
    kind: 'language',
    category: 'habit',
    path: 'growth',
    signals: ['L2', 'L5'],
    evidence: 'Used clear, specific details about parts and sizes to guide the design.',
    evidenceRefs: [`msg:${firstMsg.seq}`, `msg:${second.seq}`],
  }])
  expect(records).toHaveLength(1)
})

it('migrates v1 badge databases to v2 without losing mechanical awards and queues scopes independently', () => {
  const dir = tempDir()
  const dbPath = join(dir, 'badges.sqlite')
  const v1 = new DatabaseSync(dbPath)
  try {
    v1.exec(`CREATE TABLE reviews (
      sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, projectId TEXT NOT NULL,
      targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
      PRIMARY KEY (sessionId, turnEndSeq)
    );
    CREATE TABLE awards (
      projectId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, earnedAt TEXT NOT NULL,
      sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (projectId, kind)
    );
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, payload TEXT NOT NULL
    );
    PRAGMA application_id=1380074567;
    PRAGMA user_version=1`)
    v1.prepare('INSERT INTO awards VALUES(?,?,?,?,?,?,?)').run(
      'proj-1', 'barrel-hinge', 'award-1', '2026-11-20T00:00:00.000Z', 'sess-1', 5,
      JSON.stringify({ kind: 'barrel-hinge', evidence: 'Alternating knuckles share a pin.', working: false }),
    )
    v1.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?,?)').run('sess-1', 7, 'proj-1', '[]', 'pending', null, null)
  } finally { v1.close() }

  const store = openBadgeStore(dbPath)
  disposers.push(() => store.close())

  // Existing v1 mechanical award preserved with category='mechanical'.
  expect(store.awards()).toMatchObject([{ id: 'award-1', kind: 'barrel-hinge', category: 'mechanical' }])
  expect(store.earnedKinds('proj-1')).toEqual(['barrel-hinge'])

  // Enqueueing a habit review for the SAME (sessionId, turnEndSeq) does not collide with the migrated mechanical review.
  store.enqueue('proj-1', 'sess-1', 7, { kinds: ['language'] }, 'habit')
  const first = store.take('proj-1')
  expect(first).toMatchObject({ sessionId: 'sess-1', turnEndSeq: 7, scope: 'mechanical' })
  store.commit(first, [])
  const second = store.take('proj-1')
  expect(second).toMatchObject({ sessionId: 'sess-1', turnEndSeq: 7, scope: 'habit' })
  expect(store.commit(second, [{
    kind: 'language', category: 'habit', path: 'practice', signals: ['L1'],
    evidence: 'Described the lid and hinge clearly.', evidenceRefs: ['msg:1', 'msg:3'],
  }])).toMatchObject([{ kind: 'language' }])
  expect(store.earnedKinds('proj-1').sort()).toEqual(['barrel-hinge', 'language'])

  // A later turn in the same project can earn a second Language award (repeatable!).
  store.enqueue('proj-1', 'sess-1', 15, { kinds: ['language'] }, 'habit')
  const third = store.take('proj-1')
  expect(store.commit(third, [{
    kind: 'language', category: 'habit', path: 'growth', signals: ['L2', 'L5'],
    evidence: 'Added exact hinge clearances and wall thicknesses.', evidenceRefs: ['msg:10', 'msg:14'],
  }])).toMatchObject([{ kind: 'language', path: 'growth' }])
  expect(store.awards().filter(a => a.kind === 'language')).toHaveLength(2)
  expect(store.priorHabitAwards('proj-1', 'sess-1').language).toMatchObject({
    count: 2, lastSessionTurnEndSeq: 15,
  })
})

it('enforces non-overlapping watermarks for repeatable Patience, Language, and Persistence awards', () => {
  const project = tempDir()
  const log = buildLog()

  // Turns 1-3: earn Patience #1 (3 clean substantive turns with heavy wait).
  for (let i = 1; i <= 3; i += 1) {
    log.startTurn()
    log.user(`Step ${i}: make wall ${i + 2} mm thick`)
    log.stepStart(1)
    log.toolCall(`p${i}`, 'bash')
    log.toolResult(`p${i}`, modelReceipt(String(i).repeat(32)), { advanceMs: i === 1 ? 18_000 : 6_000 })
    log.assistant(`Finished step ${i}.`)
    log.endTurn()
  }
  const firstPatienceSeq = log.events.at(-1)!.seq
  const firstPass = extractHabitBadgeEvidence(project, log.events, ['patience'])
  expect(firstPass.patience.practiceEligible).toBe(true)

  // Turn 4 (short regular turn after watermark): must NOT re-trigger Patience immediately.
  log.startTurn()
  log.user('Round the top edge by 2 mm.')
  log.stepStart(1)
  log.toolCall('p4', 'bash')
  log.toolResult('p4', modelReceipt('4'.repeat(32)), { advanceMs: 5_000 })
  log.assistant('Rounded the top edge.')
  log.endTurn()

  const priorAfterFirst = {
    patience: { count: 1, lastEarnedAt: '2026-11-27T00:00:00.000Z', lastSessionTurnEndSeq: firstPatienceSeq, recentEvidence: ['Waited through steps 1-3.'] },
  }
  const noDoubleCount = extractHabitBadgeEvidence(project, log.events, ['patience'], priorAfterFirst)
  expect(noDoubleCount.patience.eligible).toBe(false)
  expect(noDoubleCount.eligibleKinds).toEqual([])

  // Turn 5: major wait (validation_mechanics) after watermark -> eligible for Patience #2!
  log.startTurn()
  log.user('Run the full mechanics check on the hinge.')
  log.stepStart(1)
  log.toolCall('p5', 'validation_mechanics')
  log.toolResult('p5', JSON.stringify({ status: 'passed', report: { assemblyVerified: true } }), { advanceMs: 35_000 })
  log.assistant('Mechanics check passed!')
  log.endTurn()

  const secondPatience = extractHabitBadgeEvidence(project, log.events, ['patience'], priorAfterFirst)
  expect(secondPatience.patience.eligible).toBe(true)
  expect(secondPatience.patience.majorWaitEligible).toBe(true)
  expect(secondPatience.patience.streakTurnRefs).toEqual(['turn:4', 'turn:5'])

  // Language watermark: only fresh turns after watermark qualify.
  const priorLang = {
    language: { count: 1, lastEarnedAt: '2026-11-27T00:00:00.000Z', lastSessionTurnEndSeq: firstPatienceSeq, recentEvidence: ['Specified wall thickness.'] },
  }
  const repeatLang = extractHabitBadgeEvidence(project, log.events, ['language'], priorLang)
  expect(repeatLang.eligibleKinds).toEqual(['language'])
  expect(repeatLang.freshLanguageTurnCount).toBe(2)
  expect(repeatLang.facts.priorAwards?.language).toMatchObject({ count: 1 })
})

it('migrates v2 badge databases to v3 and stores multiple habit awards per project', () => {
  const dir = tempDir()
  const dbPath = join(dir, 'badges-v2.sqlite')
  const v2 = new DatabaseSync(dbPath)
  try {
    v2.exec(`CREATE TABLE reviews (
      sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'mechanical',
      projectId TEXT NOT NULL, targets TEXT NOT NULL, status TEXT NOT NULL, worker TEXT, pid INTEGER,
      PRIMARY KEY (sessionId, turnEndSeq, scope)
    );
    CREATE TABLE awards (
      projectId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, earnedAt TEXT NOT NULL,
      sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (projectId, kind)
    );
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY, sessionId TEXT NOT NULL, turnEndSeq INTEGER NOT NULL, payload TEXT NOT NULL
    );
    PRAGMA application_id=1380074567;
    PRAGMA user_version=2`)
    v2.prepare('INSERT INTO awards VALUES(?,?,?,?,?,?,?)').run(
      'proj-2', 'patience', 'old-pat-1', '2026-11-27T01:00:00.000Z', 'sess-2', 4,
      JSON.stringify({ kind: 'patience', category: 'habit', path: 'practice', signals: ['P1'], evidence: 'Waited through builds.' }),
    )
  } finally { v2.close() }

  const store = openBadgeStore(dbPath)
  disposers.push(() => store.close())
  store.enqueue('proj-2', 'sess-2', 12, { kinds: ['patience'] }, 'habit')
  const job = store.take('proj-2')
  const inserted = store.commit(job, [{
    kind: 'patience', category: 'habit', path: 'growth', signals: ['P5', 'P3'],
    evidence: 'Settled down and waited for the validation run.', evidenceRefs: ['turn:5', 'turn:6'],
  }])
  expect(inserted).toMatchObject([{ kind: 'patience', path: 'growth' }])
  expect(store.awards().filter(a => a.kind === 'patience')).toHaveLength(2)
})

it('queues and announces habit awards alongside mechanical reviews in createBadgeHost', async () => {
  const home = tempDir('rumi-habit-host-')
  const workspace = join(home, 'workspace')
  const projectId = randomUUID()
  const project = join(workspace, projectId)
  mkdirSync(join(project, 'models', 'box'), { recursive: true })
  const sessionId = randomUUID()
  const session = { id: sessionId, header: { id: sessionId, cwd: project } }
  writeFileSync(join(project, 'project.json'), JSON.stringify({ id: projectId, name: 'Treasure Box', type: 'print', sessionIds: [sessionId] }))

  const history: Event[] = []
  let listener: (s: typeof session, e: Event) => void
  const announcements: PrintBadgeEarned[] = []
  let dispose: (() => Promise<void>) | undefined
  const ctx = {
    rumiProjectScope: { workspaceRoot: workspace },
    logger: { warn: vi.fn() },
    sessionQuery: {
      observeSession: async () => ({ header: session.header, inheritedEventCount: 0, events: history.slice(), [Symbol.dispose]() {} }),
    },
    on(_type: string, handle: typeof listener) { listener = handle },
    async parallel(_type: 'rumi/print-badge-earned', event: PrintBadgeEarned) { announcements.push(event) },
    effect(fn: () => () => Promise<void>) { dispose = fn() },
  }

  const reviewHabits = vi.fn(async () => [{
    kind: 'language', category: 'habit', path: 'practice', signals: ['L1', 'L2'],
    evidence: 'Described exact box dimensions and lid placement.', evidenceRefs: ['msg:1', 'msg:4'],
  }])
  const host = createBadgeHost(ctx, {
    databasePath: join(home, 'print-studio', 'badges.sqlite'),
    config: {},
    capture: capturePrintBadgeRevisions,
    review: async () => [],
    reviewHabits,
  })
  disposers.push(async () => { await dispose?.() })

  const emit = (type: string, data: Record<string, unknown>) => {
    const event = { type, seq: history.length, data }
    history.push(event)
    listener(session, event)
  }

  emit('turn/start', { turn: 1 })
  emit('user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Make a 60 mm treasure box.' }] })
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await host.whenIdle()

  expect(reviewHabits).toHaveBeenCalledOnce()
  expect(host.collection(projectId).awards).toMatchObject([{
    kind: 'language', category: 'habit', projectName: 'Treasure Box',
  }])
  expect(announcements).toMatchObject([{
    projectId, projectName: 'Treasure Box', awards: [{ kind: 'language' }],
  }])
})

it('falls back to DeepSeek via Baseten or the active session route when DeepSeek API credentials are missing', async () => {
  const project = tempDir()
  const log = buildLog()
  log.events.push({
    type: 'request/header', seq: log.events.length, time: 1_700_000_000_000,
    data: { header: { config: { provider: 'rumi-chatgpt', model: 'gpt-6.2-sol' } } },
  })
  log.startTurn()
  const m1 = log.user('Make a 50 mm wide box with a 3 mm lip on top.')
  log.assistant('Built the box.')
  log.endTurn()
  log.startTurn()
  const m2 = log.user('Keep the base 50 mm wide and add a 12 mm finger notch centered on the front lid.')
  log.assistant('Added the finger notch.')
  log.endTurn()

  const attempted: string[] = []
  const makeError = (code: string) => Object.assign(new Error(code), { code })

  // Case 1: deepseek-official missing credential in stream -> falls back to baseten, handles markdown-fenced JSON.
  const basetenFallback = vi.fn(async (controls: { provider: string; model: string }, _signal: AbortSignal, adjust?: (c: object, m: object) => object) => {
    attempted.push(`${controls.provider}:${controls.model}`)
    const resolved = adjust ? adjust(controls, { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }) : controls
    return {
      config: resolved,
      async *stream(): AsyncIterable<StreamChunk> {
        if (controls.provider === 'deepseek-official') throw makeError('MISSING_CREDENTIAL')
        yield {
          type: 'text-delta', index: 0, text: `\`\`\`json\n${JSON.stringify({
            findings: [{ kind: 'language', path: 'practice', signals: ['L1', 'L2'], refs: [`msg:${m1.seq}`, `msg:${m2.seq}`],
              evidence: 'Specified exact 50 mm width, 3 mm lip, and a centered 12 mm front finger notch.' }],
          })}\n\`\`\``,
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  })

  const config = createBadgeReviewConfig(z)({})
  const awards = await reviewHabitBadges({ llm: { prepareCall: basetenFallback } }, {
    session: { id: 's-baseten' }, project: { path: project }, turnEndSeq: log.events.at(-1)!.seq,
    events: log.events, unearnedKinds: ['language'], signal: new AbortController().signal,
    recordRequest: async () => {},
  }, config)

  expect(attempted).toEqual([
    'deepseek-official:deepseek-flash',
    'baseten:deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast',
  ])
  expect(awards).toMatchObject([{ kind: 'language', path: 'practice' }])

  // Case 2: deepseek-official missing + baseten unknown model -> falls back to session request/header route.
  const attempted2: string[] = []
  const sessionFallback = vi.fn(async (controls: { provider: string; model: string }, _signal: AbortSignal, adjust?: (c: object, m: object) => object) => {
    attempted2.push(`${controls.provider}:${controls.model}`)
    if (controls.provider === 'baseten') throw makeError('UNKNOWN_MODEL')
    const resolved = adjust ? adjust(controls, { reasoning: { efforts: [{ id: 'low' }] } }) : controls
    return {
      config: resolved,
      async *stream(): AsyncIterable<StreamChunk> {
        if (controls.provider === 'deepseek-official') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'no key' } } }
          return
        }
        yield {
          type: 'text-delta', index: 0, text: JSON.stringify({
            findings: [{ kind: 'language', path: 'practice', signals: ['L1', 'L2'], refs: [`msg:${m1.seq}`, `msg:${m2.seq}`],
              evidence: 'Gave exact box width, lip thickness, and centered notch size.' }],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  })

  const awards2 = await reviewHabitBadges({ llm: { prepareCall: sessionFallback } }, {
    session: { id: 's-chatgpt' }, project: { path: project }, turnEndSeq: log.events.at(-1)!.seq,
    events: log.events, unearnedKinds: ['language'], signal: new AbortController().signal,
    recordRequest: async () => {},
  }, config)

  expect(attempted2).toEqual([
    'deepseek-official:deepseek-flash',
    'baseten:deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast',
    'rumi-chatgpt:gpt-6.2-sol',
  ])
  expect(awards2).toMatchObject([{ kind: 'language', path: 'practice' }])
})
