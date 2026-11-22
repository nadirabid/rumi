/** Command failures retain their diagnostics through Rumi's real tool runtime. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as BashEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as Brand from '../brand/index.js'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

it.skipIf(process.platform === 'win32').each([false, true])('reports command failures with the job registry enabled: %s', async (jobs) => {
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(BashEnv)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    if (jobs) await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolBash)
    const policy = ctx.plugin(Brand)
    await policy
    const call = (command: string) => executeModelToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(command), name: 'bash',
      arguments: { command, description: 'Check command outcome' },
    })
    const failed = await call("printf 'validation failed\\n' >&2; exit 1")
    expect({ isError: failed.isError, content: failed.content, error: failed.error }).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "[stderr]
      validation failed
      [exit code: 1]",
            "type": "text",
          },
        ],
        "error": {
          "info": {
            "code": "RUMI_SHELL_COMMAND_FAILED",
            "name": "ShellCommandError",
          },
          "message": "Bash command failed with exit code 1.",
        },
        "isError": true,
      }
    `)
    expect(failed).not.toHaveProperty('value')
    expect((await call("printf 'exit code: 1'")).isError).toBe(false)
    const invalid = await call('')
    expect(invalid.isError).toBe(true)
    expect(invalid.error?.info?.code).not.toBe('RUMI_SHELL_COMMAND_FAILED')
    await policy.dispose()
    expect((await call('exit 1')).isError).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})


it.skipIf(process.platform === 'win32')('records the command failure in the agent session', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(BashEnv)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    await ctx.plugin(ToolBash)
    await ctx.plugin(Brand)
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new MockAdapter([
      toolCallResponse('validate', 'bash', { command: "printf 'validation failed\\n' >&2; exit 1", description: 'Validate fields' }),
      textResponse('Validation failed.'),
    ])
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const agent = await harness.create(SessionId('rumi-command-failure'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Validate the fields.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results.map(result => ({ isError: result.isError, content: result.content }))).toMatchSnapshot()
  } finally {
    await ctx.fiber.dispose()
  }
})


it.each([
  { name: 'bash', kind: 'foreground', exitCode: 0, signal: null, timedOut: true, error: true },
  { name: 'bash', kind: 'foreground', exitCode: null, signal: 'SIGTERM', timedOut: false, error: true },
  { name: 'bash', kind: 'background', exitCode: null, signal: null, timedOut: false, error: false },
  { name: 'bash', kind: 'promoted', exitCode: null, signal: null, timedOut: false, error: false },
  { name: 'other', kind: 'foreground', exitCode: 1, signal: null, timedOut: false, error: false },
])('classifies $name $kind with timeout=$timedOut and signal=$signal', async ({ name, error, ...value }) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(Brand)
    ctx.effect(() => ctx.tools.register(defineTool({
      name, description: 'Return a process outcome', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
        } },
        render: () => [{ type: 'text', text: 'Process output' }],
      },
      presentCall: () => ({ card: 'generic', title: 'Process' }),
      execute: async () => value,
    })))
    const result = await executeModelToolFixture(ctx, { signal: new AbortController().signal, callId: ToolCallId('outcome'), name, arguments: {} })
    expect(result.isError).toBe(error)
    expect(result.content).toEqual([{ type: 'text', text: 'Process output' }])
  } finally {
    await ctx.fiber.dispose()
  }
})
