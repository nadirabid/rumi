/** Native request admission retains current context without erasing action or input history. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createDeveloperMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { applyContextRetention } from '../viewer/context-retention.js'

it('keeps one full context across changed and unchanged requests with durable original snapshots', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    applyContextRetention(ctx, createDeveloperMessage)
    let selection = 'helmet'
    ctx.systemPrompt.context({ name: 'rumi:mesh-state', order: 210, required: true,
      text: () => JSON.stringify({ meshState: { selection, workingModel: 'helmet' } }) })
    const failed: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry' } } }]
    ctx.tools.register(defineContentToolFixture({ name: 'edit', description: 'Record the edit outcome', parameters: {},
      async execute() { return [{ type: 'text', text: 'Helmet edit saved.' }] },
    }))
    const adapter = new MockAdapter([toolCallResponse('edit-one', 'edit', {}), textResponse('one'), failed, textResponse('two'), textResponse('three')])
    ctx.on('agent/request-error', async () => { selection = 'dragon'; return { kind: 'retry' as const } })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('rumi-context'), { provider: 'mock', model: 'mock' })
    const originalSnapshots: string[] = []
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'runtime-context') {
        originalSnapshots.push(JSON.stringify(event.data.content))
      }
    })
    async function send(text: string) {
      const idle = new Promise<void>((resolve) => {
        const stop = ctx.on('agent/status', ({ agent: subject, status }: { agent: Agent; status: string }) => {
          if (subject === agent && status === 'idle') { stop(); resolve() }
        })
      })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await idle
    }
    await send('edit helmet')
    selection = 'cube'
    await send('continue')
    await send('continue again')
    for (const request of adapter.requests) {
      expect(request.messages.filter(message => message.source.kind === 'runtime-context')).toHaveLength(1)
    }
    const latest = adapter.requests[4]!.messages
    expect(latest.filter(message => message.source.kind === 'user')).toHaveLength(3)
    expect(latest.filter(message => message.role === 'assistant')).toHaveLength(3)
    expect(latest.find(message => message.role === 'tool')?.content).toEqual([{ type: 'text', text: 'Helmet edit saved.' }])
    const context = latest.find(message => message.source.kind === 'runtime-context')!
    expect(context.content).toEqual([{ type: 'text', text: expect.stringContaining('"selection":"dragon","workingModel":"helmet"') }])
    expect(originalSnapshots).toHaveLength(5)
    expect(originalSnapshots[0]).toContain('helmet')
    expect(adapter.requests.map(request => request.messages.filter(message => message.source.kind === 'runtime-context').map(message => message.content))).toMatchSnapshot()
  } finally { await ctx.fiber.dispose() }
})
