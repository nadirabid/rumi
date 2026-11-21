/** Keyless replay of the Bison review through the DSH stopping checkpoint. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applySkillReminders } from '../skill-reminders.js'

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
  { scenario: 'the region decision is negative', status: 'missing', score: 0.01, malformed: false, expected: ['project reply guidance'] },
  { scenario: 'the decision response is malformed', status: 'missing', score: 0.99, malformed: true, expected: [] },
])('reviews one closing draft when $scenario', async ({ status, score, malformed, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-review-'))
  const ctx = new Context()
  try {
    const sessionId = SessionId('print-skill-review')
    await writeFile(join(root, 'project.json'), JSON.stringify({ id: basename(root), type: 'print', sessionIds: [sessionId] }))
    const directory = join(root, 'models', 'box')
    await mkdir(directory, { recursive: true })
    const adapter = new ReviewReplay(async () => {
      if (status === null) return
      const usd = '#usda 1.0\n'
      await writeFile(join(directory, 'model.usda'), usd)
      if (status === 'ready') {
        await writeFile(join(directory, 'model.regions.json'), JSON.stringify({
          sourceHash: createHash('sha256').update(usd).digest('hex'),
          remainder: 'Box',
          regions: [{ id: 'lid', name: 'Lid', boxes: [[0, 0, 0, 1, 1, 1]] }],
        }))
      }
    })
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
    const fetchDecision = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        state: {
          request: 'Make a box.',
          draft: 'The box is ready. Here are all the details.',
          changedModels: status ? [{ regionMap: status }] : [],
        },
        questions: { namedRegions: { type: 'noul' }, conciseReply: { type: 'noul' } },
      })
      return Response.json({ answers: {
        namedRegions: { type: 'noul', noul: malformed ? null : score },
        conciseReply: { type: 'noul', noul: 0.95 },
      } })
    })
    applySkillReminders(ctx, { enabled: true, maxTextChars: 4000, maxModels: 16, timeoutMs: 2000, threshold: 0.8 },
      async () => 'fixture-key', createUserMessage)
    const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' }, { cwd: root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Make a box.' }] }))
    await agent.whenIdle()
    expect(fetchDecision).toHaveBeenCalledTimes(1)
    const events = agent.session.snapshotEvents()
    const reminders = events.flatMap(event => event.type === 'user/message' && String(event.data.source.kind) === 'rumi-skill-reminder'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(adapter.requests).toHaveLength(expected.length ? 2 : 1)
    expect(reminders).toHaveLength(expected.length ? 1 : 0)
    for (const reminder of expected) expect(reminders[0]).toContain(reminder)
    if (!expected.includes('name-model-regions')) expect(reminders[0] ?? '').not.toContain('name-model-regions')
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
  } finally {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
