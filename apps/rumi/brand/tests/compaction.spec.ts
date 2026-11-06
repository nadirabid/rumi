/** Rumi's active policy triggers real automatic compaction before the next model request. */
import { Context } from '@deepseek-ai/cordis'
import { createDeveloperMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { expect, it } from 'vitest'
import { apply, Config } from '../preset.js'
import { applyContextRetention } from '../print-studio/viewer/context-retention.js'

class Adapter extends LlmAdapter {
  summaries = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_048_576 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summary = options.messages.at(-1)?.content.some(block => block.type === 'text'
      && block.text.includes('acting as a compaction engine')) === true
    if (summary) this.summaries++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary ? 'Earlier work completed.' : 'Done.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each([0.3, 0.8])('uses the registered %s policy for automatic session compaction', async (ratio) => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    applyContextRetention(ctx, createDeveloperMessage)
    ctx.systemPrompt.context({ name: 'rumi:test-state', order: 210, required: true, text: () => 'Current mesh state.' })
    let policy: { thresholdRatio: number } | undefined
    const registrar = { agentPresets: { register(preset: {
      id: string
      plugins: { id: string; config: { name: string; config: { thresholdRatio: number } }[] }[]
    }) {
      if (preset.id === 'standard') {
        policy = preset.plugins.find(row => row.id === 'compaction')!.config
          .find(row => row.name === '@deepseek-ai/dsh-compaction-basic')!.config
      }
    } } }
    for await (const _ of apply(registrar, Config.parse({ compactionThresholdRatio: ratio }))) { /* Mount every preset. */ }
    expect(policy).toEqual({ thresholdRatio: ratio })
    await ctx.plugin(BasicCompaction, policy!)
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId(`rumi-compaction-${ratio}`), { provider: 'mock', model: 'mock', maxTokens: 256000 })
    let recorded = 0
    ctx.on('session/event', (_session, event) => { if (event.type === 'compaction/summary') recorded++ })
    for (let turn = 0; turn < 4; turn++) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'context '.repeat(50000) }] }))
      await agent.whenIdle()
    }
    const before = ctx.tokenMeter.measure(agent.session).totalTokens
    expect(before).toBeGreaterThan(1_048_576 * 0.3)
    expect(before).toBeLessThan(1_048_576 * 0.6)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }))
    await agent.whenIdle()
    expect(recorded).toBe(ratio === 0.3 ? 1 : 0)
    expect(adapter.summaries).toBe(recorded)
    if (ratio === 0.3) expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(1_048_576 * 0.3)
    expect({ ratio, summaries: recorded, belowThreshold: ctx.tokenMeter.measure(agent.session).totalTokens < 1_048_576 * 0.3 })
      .toMatchSnapshot()
  } finally { await ctx.fiber.dispose() }
})
