/** Keyless replays of Bison reviews through DSH turns. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applySkillReminders } from '../skill-reminders.js'

const config = { enabled: true, everySteps: 1, maxTextChars: 4000, maxModels: 16, timeoutMs: 2000, threshold: 0.8 }

function decision(namedRegions = 0.01, conciseReply = 0.01) {
  return Response.json({ answers: {
    namedRegions: { type: 'noul', noul: namedRegions },
    conciseReply: { type: 'noul', noul: conciseReply },
  } })
}

async function identifyProject(root: string, sessionId: SessionId) {
  await writeFile(join(root, 'project.json'), JSON.stringify({ id: basename(root), type: 'print', sessionIds: [sessionId] }))
}

class ReviewReplay extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private readonly publish: () => Promise<void>) { super() }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const first = this.requests.length === 1
    if (first) await this.publish()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: first ? 'The box is ready. Here are all the details.' : 'I saved the box and its labels.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each([
  { scenario: 'both decisions are positive', status: 'missing', score: 0.99, malformed: false, expected: ['name-model-regions', 'project reply guidance'] },
  { scenario: 'there is no changed mesh', status: null, score: 0.99, malformed: false, expected: ['project reply guidance'] },
  { scenario: 'the changed mesh has a matching map', status: 'ready', score: 0.99, malformed: false, expected: ['project reply guidance'] },
  { scenario: 'only the map changed and it still uses legacy boxes', status: 'needs_surface_regions', score: 0.99, malformed: false, expected: ['name-model-regions', 'project reply guidance'] },
  { scenario: 'the region decision is negative', status: 'missing', score: 0.01, malformed: false, expected: ['project reply guidance'] },
  { scenario: 'the decision response is malformed', status: 'missing', score: 0.99, malformed: true, expected: [] },
])('reviews one closing draft when $scenario', async ({ status, score, malformed, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-review-'))
  const ctx = new Context()
  try {
    const sessionId = SessionId('print-skill-review')
    await identifyProject(root, sessionId)
    const directory = join(root, 'models', 'box')
    await mkdir(directory, { recursive: true })
    const usd = '#usda 1.0\n'
    const refresh = status === 'needs_surface_regions'
    if (refresh) await writeFile(join(directory, 'model.usda'), usd)
    const request = refresh ? 'Refresh the names on the box.' : 'Make a box.'
    const adapter = new ReviewReplay(async () => {
      if (status === null) return
      if (!refresh) await writeFile(join(directory, 'model.usda'), usd)
      if (refresh || status === 'ready') {
        await writeFile(join(directory, 'model.regions.json'), JSON.stringify({
          sourceHash: createHash('sha256').update(usd).digest('hex'),
          regions: [refresh ? { id: 'lid', name: 'Lid', boxes: [[0, 0, 0, 1, 1, 1]] }
            : { id: 'lid', name: 'Lid', location: { kind: 'surface', parts: [{ partPath: ['Lid'] }] } }],
        }))
      }
    })
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
    const fetchDecision = vi.fn<typeof fetch>(async (_url, options) => {
      if (fetchDecision.mock.calls.length > 1) return decision()
      const body = JSON.parse(String(options?.body))
      expect(Object.keys(body.questions).sort()).toEqual(['conciseReply', 'namedRegions'])
      expect(body).toMatchObject({
        state: {
          request,
          draft: 'The box is ready. Here are all the details.',
          changedModels: status ? [{ change: refresh ? 'region_map_revised' : 'created', regionMap: status }] : [],
        },
        questions: { namedRegions: { type: 'noul' }, conciseReply: { type: 'noul' } },
      })
      return Response.json({ answers: {
        namedRegions: { type: 'noul', noul: malformed ? null : score },
        conciseReply: { type: 'noul', noul: 0.95 },
      } })
    })
    applySkillReminders(ctx, config, async () => 'fixture-key', createUserMessage, fetchDecision)
    const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' }, { cwd: root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }))
    await agent.whenIdle()
    expect(fetchDecision).toHaveBeenCalledTimes(expected.length === 1 ? 2 : 1)
    const events = agent.session.snapshotEvents()
    const reminders = events.flatMap(event => event.type === 'user/message' && String(event.data.source.kind) === 'rumi-skill-reminder'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(adapter.requests).toHaveLength(expected.length ? 2 : 1)
    expect(reminders).toHaveLength(expected.length ? 1 : 0)
    for (const reminder of expected) expect(reminders[0]).toContain(reminder)
    if (expected.length) {
      const userText = adapter.requests[1]?.messages.flatMap(message => message.role === 'user'
        ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
      expect(userText).toContain(request)
      expect(userText).toContain(reminders[0])
      expect(reminders[0]).toContain("Keep working toward the user's goal, including any remaining edits or checks.")
    }
    if (expected.includes('name-model-regions')) {
      expect(reminders[0]).toContain('Use viewer_analyze_surfaces to identify physical features and audit each saved map for unnamed triangles.')
      expect(reminders[0]).toContain(JSON.stringify([{ path: 'models/box/model.usda', status }]))
    } else {
      expect(reminders[0] ?? '').not.toContain('name-model-regions')
    }
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

class StepReplay extends LlmAdapter {
  step = 0

  constructor(private readonly whenReady: (step: number) => Promise<void>, private readonly tool = 'inspect') { super() }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    const step = ++this.step
    await this.whenReady(step)
    const hasText = this.tool !== 'bash' || step >= 4
    if (hasText) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Progress ${step}.` } }
    }
    if (step < 4) {
      const index = hasText ? 1 : 0
      yield { type: 'block-start', index, blockType: 'tool-call' }
      const args = this.tool === 'bash'
        ? { description: ['Publish the box model', 'Check the section profile', 'Verify the corrected mesh'][step - 1], command: 'local-script-with-private-content' }
        : {}
      yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`tool-${step}`), name: this.tool, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('coalesces completed steps and keeps one Bison request across active turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-review-queue-'))
  const owner = new Context()
  const firstRequest = Promise.withResolvers<void>()
  const releaseFirstRequest = Promise.withResolvers<void>()
  const thirdStep = Promise.withResolvers<void>()
  const otherStopping = Promise.withResolvers<void>()
  const mergedRequest = Promise.withResolvers<void>()
  try {
    const primaryId = SessionId('print-review-primary')
    const otherId = SessionId('print-review-other')
    const primaryRoot = join(root, 'primary')
    const otherRoot = join(root, 'other')
    await mkdir(primaryRoot)
    await mkdir(otherRoot)
    await identifyProject(primaryRoot, primaryId)
    await identifyProject(otherRoot, otherId)
    await mountAgentLoopTestDependencies(owner)
    const harness = await mountAgentLoopTestHarness(owner)
    const adapter = new StepReplay(async (step) => {
      if (step === 2) await firstRequest.promise
      if (step === 4) await mergedRequest.promise
    }, 'bash')
    owner.effect(() => owner.llm.registerAdapter(['primary'], adapter))
    owner.effect(() => owner.llm.registerAdapter(['other'], new ReviewReplay(async () => {})))
    owner.effect(() => owner.tools.register(defineContentToolFixture({
      name: 'bash', description: 'Run a fixture command.',
      parameters: { command: { type: 'string', required: true }, description: { type: 'string', required: true } },
      async execute(_args, exec) {
        if (adapter.step === 1) exec.agent?.session.append('todo/write', { todos: [{ content: 'Inspect the saved box', status: 'in_progress' }] })
        const marker = adapter.step === 1 ? '\nRUMI_CHECKS {"status":"needs_repair"}' : adapter.step === 2 ? '\n[exit code: 1]' : ''
        return [{ type: 'text', text: `Raw tool output that stays local.${marker}` }]
      },
    })))
    owner.on('session/event', (session, event) => {
      if (session.id === primaryId && event.type === 'step/end' && event.data.step === 3) thirdStep.resolve()
    })
    owner.on('agent/turn-stopping', ({ agent }) => {
      if (agent.session.id === otherId) otherStopping.resolve()
    })
    const fetchDecision = vi.fn<typeof fetch>(async () => {
      if (fetchDecision.mock.calls.length === 1) {
        firstRequest.resolve()
        await releaseFirstRequest.promise
      } else if (fetchDecision.mock.calls.length === 2) {
        mergedRequest.resolve()
      }
      return decision()
    })
    applySkillReminders(owner, { ...config, timeoutMs: 10_000 }, async () => 'fixture-key', createUserMessage, fetchDecision)
    const primary = await harness.create(primaryId, { provider: 'primary', model: 'fixture' }, { cwd: primaryRoot })
    const other = await harness.create(otherId, { provider: 'other', model: 'fixture' }, { cwd: otherRoot })
    const prompt = (value: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] })
    primary.followup(prompt('Inspect the primary model.'))
    await firstRequest.promise
    other.followup(prompt('Inspect the other model.'))
    await Promise.all([thirdStep.promise, otherStopping.promise])
    expect(fetchDecision).toHaveBeenCalledTimes(1)
    other.cancel({ kind: 'user' })
    await other.whenIdle()
    releaseFirstRequest.resolve()
    await primary.whenIdle()
    expect(fetchDecision).toHaveBeenCalledTimes(3)
    const states = fetchDecision.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).state)
    const publish = { step: 1, tool: 'bash', description: 'Publish the box model', outcome: 'completed', geometryCheck: 'needs_repair' }
    const inspect = { step: 2, tool: 'bash', description: 'Check the section profile', outcome: 'failed' }
    const verify = { step: 3, tool: 'bash', description: 'Verify the corrected mesh', outcome: 'completed' }
    const plan = [{ task: 'Inspect the saved box', status: 'in_progress' }]
    expect(states).toMatchObject([
      { draft: '', completedStep: 1, plan, recentActions: [publish] },
      { draft: '', completedStep: 3, plan, recentActions: [publish, inspect, verify] },
      { draft: 'Progress 4.', completedStep: 4, plan, recentActions: [publish, inspect, verify] },
    ])
    const bodies = fetchDecision.mock.calls.map(([, options]) => String(options?.body)).join('')
    expect(bodies).not.toContain('Raw tool output')
    expect(bodies).not.toContain('local-script-with-private-content')
    expect(states.every(state => state.request === 'Inspect the primary model.')).toBe(true)
  } finally {
    firstRequest.resolve()
    releaseFirstRequest.resolve()
    mergedRequest.resolve()
    await owner.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('steers at the next step when the every-other-step review flags a missing region map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-review-steering-'))
  const owner = new Context()
  const reminderQueued = Promise.withResolvers<void>()
  try {
    const sessionId = SessionId('print-review-steering')
    await identifyProject(root, sessionId)
    const directory = join(root, 'models', 'box')
    await mkdir(directory, { recursive: true })
    await mountAgentLoopTestDependencies(owner)
    const harness = await mountAgentLoopTestHarness(owner)
    const adapter = new StepReplay(async (step) => {
      if (step === 3) await reminderQueued.promise
    })
    owner.effect(() => owner.llm.registerAdapter(['fixture'], adapter))
    owner.effect(() => owner.tools.register(defineContentToolFixture({
      name: 'inspect', description: 'Inspect project geometry.', parameters: {},
      async execute() {
        if (adapter.step === 1) await writeFile(join(directory, 'model.usda'), '#usda 1.0\n')
        return [{ type: 'text', text: 'Geometry inspected.' }]
      },
    })))
    owner.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.id === sessionId && String(message.source.kind) === 'rumi-skill-reminder') {
        reminderQueued.resolve()
      }
    })
    const fetchDecision = vi.fn<typeof fetch>(async () => decision(0.99, 0.01))
    applySkillReminders(owner, { ...config, everySteps: 2 }, async () => 'fixture-key', createUserMessage, fetchDecision)
    const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' }, { cwd: root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the box.' }] }))
    await agent.whenIdle()
    const states = fetchDecision.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).state)
    expect(states.map(state => state.draft)).toEqual(['Progress 1.\nProgress 2.', 'Progress 3.\nProgress 4.'])
    const events = agent.session.snapshotEvents()
    const reminders = events.filter(event => event.type === 'user/message').filter(event => String(event.data.source.kind) === 'rumi-skill-reminder')
    const thirdReply = events.find(event => event.type === 'assistant/message' && event.data.step === 3)
    const finalReply = events.find(event => event.type === 'assistant/message' && event.data.step === 4)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.data.content).toEqual([{ type: 'text', text: expect.stringContaining('Before ending this turn, follow name-model-regions and save maps that match the final revisions you keep.') }])
    expect(reminders[0]?.seq).toBeGreaterThan(thirdReply?.seq ?? Infinity)
    expect(reminders[0]?.seq).toBeLessThan(finalReply?.seq ?? -1)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  } finally {
    reminderQueued.resolve()
    await owner.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
