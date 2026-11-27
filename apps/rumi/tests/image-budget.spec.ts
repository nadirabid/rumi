/** Recorded offloads cap provider input while preserving original image attachments. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as offload from '@deepseek-ai/dsh-compaction-image-offload'
import { expect, it } from 'vitest'
import * as budget from '../plugins/brand/image-budget.js'

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Checked.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('keeps the newest 20 across repeated image batches without sending excess to the provider', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(offload)
    await ctx.plugin(budget, { maxImages: 20 })
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('rumi-image-budget'), { provider: 'mock', model: 'mock' })
    const decisions: number[][] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'image/offload') decisions.push(event.data.targets.map(target => target.imageIndexes.length))
    })
    for (const [batch, size] of [20, 14, 14, 0].entries()) {
      const content: ContentBlock[] = [{ type: 'text', text: `Findings ${batch}` }]
      for (let index = 0; index < size; index++) content.push({
        type: 'image',
        attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name: `${batch}:${index}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content }))
      await agent.whenIdle()
    }
    expect(adapter.requests).toHaveLength(4)
    const images = adapter.requests.map(request => request.messages.flatMap(message => message.content)
      .filter(block => block.type === 'image' && block.offloaded !== true)
      .map(block => block.type === 'image' ? block.attachment.name : ''))
    expect(images.map(list => list.length)).toEqual([20, 20, 20, 20])
    expect(images[2]).toEqual([...Array.from({ length: 6 }, (_, i) => `1:${i + 8}`), ...Array.from({ length: 14 }, (_, i) => `2:${i}`)])
    expect(images[3]).toEqual(images[2])
    expect(decisions).toEqual([[14], [6, 8]])
    expect({ decisions, images }).toMatchSnapshot()
    expect(adapter.requests[3]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text' && block.text.startsWith('Findings'))).toHaveLength(4)
  } finally { await ctx.fiber.dispose() }
})
