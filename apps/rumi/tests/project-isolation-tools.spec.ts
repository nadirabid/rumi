/** Real tool dispatch and saved-session policy cannot widen Rumi project access. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createProjectScope } from '../brand/projects/isolation/scope-provider.js'
import { createProjectPolicy } from '../brand/projects/isolation/policy-provider.js'
import { createProjectFileSystem } from '../brand/projects/isolation/filesystem-provider.js'
const ProjectScope = createProjectScope({ Service, z })
const ProjectPolicy = createProjectPolicy({ SandboxPolicyService })
const ProjectFileSystem = createProjectFileSystem({ LocalFileSystem })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(runtimeRoots: string[] = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'rumi-project-tools-'))
  cleanup.push(() => rm(workspace, { recursive: true, force: true }))
  const root = join(workspace, '11111111-1111-4111-8111-111111111111'), sibling = join(workspace, 'other')
  await mkdir(root); await mkdir(sibling)
  await writeFile(join(root, 'project.json'), JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', sessionIds: ['session-a'] }))
  await writeFile(join(root, 'own.txt'), 'own project'); await writeFile(join(sibling, 'private.txt'), 'other project')
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ProjectScope, { workspaceRoot: workspace, runtimeRoots })
  await ctx.plugin(ProjectPolicy)
  await ctx.plugin(ProjectFileSystem)
  const harness = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([toolCallResponse('read-other', 'read', { path: '../other/private.txt' }), textResponse('That file must be imported into this project first.')])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read', description: 'Read a project file.', parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: () => ({ card: 'generic', title: 'Read file' }),
    async execute(args, exec) { return ctx.fs.readText(await ctx.fs.resolve(args.path, { cwd: exec.agent!.session.header.cwd! })) } })))
  const agent = await harness.create(SessionId('session-a'), { provider: 'mock', model: 'mock' }, { cwd: root })
  return { ctx, agent, root, sibling, adapter, harness, workspace }
}
it.skipIf(process.platform !== 'darwin')('blocks a cross-project read in a recorded agent turn without disclosing contents', async () => {
  const f = await fixture()
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the file in the other project.' }] }))
  await f.agent.whenIdle()
  const results = f.agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(true)
  expect(JSON.stringify(results)).not.toContain('other project')
  expect(results.map(result => ({ isError: result.isError, content: result.content }))).toMatchSnapshot()
  expect(await readFile(join(f.sibling, 'private.txt'), 'utf8')).toBe('other project')
})
it.skipIf(process.platform !== 'darwin')('ignores full-access overrides and denies escalation and unaudited tools', async () => {
  const f = await fixture()
  const policy = f.ctx.sandboxPolicy.resolve({ session: f.agent.session, mode: 'danger-full-access' })
  expect(policy.mode).toBe('workspace-write')
  expect(policy.workspaceRoot).toContain('11111111-1111-4111-8111-111111111111')
  const execute = (name: string, args: object) => f.ctx.tools.execute({ callId: ToolCallId('test'), name, arguments: args, agent: f.agent, signal: new AbortController().signal })
  expect(await execute('read', { path: 'own.txt' })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'own project' }] })
  expect(await execute('read', { path: 'own.txt', sandbox_permissions: 'require_escalated' })).toMatchObject({ isError: true })
  f.ctx.effect(() => f.ctx.tools.register(defineTool({ name: 'unreviewed', description: 'Unaudited plugin.', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, presentCall: () => ({ card: 'generic', title: 'Unreviewed' }), execute: async () => 'must not run' })))
  expect(await execute('unreviewed', {})).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: This capability is not enabled for isolated Rumi projects.' }] })
})

it.skipIf(process.platform !== 'darwin')('confines actual shell and direct search-style subprocesses under the same active project', async () => {
  const { SandboxProvider } = await import('@deepseek-ai/dsh-sandbox')
  const { SandboxBashExecutor } = await import('@deepseek-ai/dsh-bash-sandbox')
  const { LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
  const { createProjectSandbox } = await import('../brand/projects/isolation/sandbox-provider.js')
  const { createProjectShell } = await import('../brand/projects/isolation/shell-provider.js')
  const { createProjectSubprocess } = await import('../brand/projects/isolation/subprocess-provider.js')
  const f = await fixture(['/System', '/usr', '/bin', '/opt/homebrew'])
  await f.ctx.plugin(createProjectSandbox({ SandboxProvider }))
  await f.ctx.plugin(createProjectSubprocess({ LocalSubprocessRuntime }))
  await f.ctx.plugin(createProjectShell({ SandboxBashExecutor }))
  f.ctx.effect(() => f.ctx.tools.register(defineTool({ name: 'bash', description: 'Run a project command.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, presentCall: () => ({ card: 'generic', title: 'Run command' }),
    async execute(_args, exec) {
      const shell = await f.ctx.shell.execute(f.ctx.shell.resolve({ command: 'cat own.txt; cat ../other/private.txt; printf blocked > ../other/new.txt', workdir: f.root, signal: exec.signal }))
      const result = await shell.result()
      const child = f.ctx.subprocess.spawn({ argv: ['/bin/cat', '../other/private.txt'], cwd: f.root, signal: exec.signal, graceMs: 1000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } } })
      const outcome = await child.done
      return JSON.stringify({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, childExit: outcome.exitCode })
    } })))
  const result = await f.ctx.tools.execute({ callId: ToolCallId('bash'), name: 'bash', arguments: {}, agent: f.agent, signal: new AbortController().signal })
  expect(JSON.stringify(result)).toContain('own project')
  expect(JSON.stringify(result)).not.toContain('other project')
  expect(JSON.stringify(result)).toContain('Operation not permitted')
  await expect(readFile(join(f.sibling, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform !== 'darwin')('keeps concurrent sessions bound to their own directories', async () => {
  const f = await fixture()
  const id = '22222222-2222-4222-8222-222222222222'
  const root = join(f.workspace, id)
  await mkdir(root)
  await writeFile(join(root, 'project.json'), JSON.stringify({ id, sessionIds: ['session-b'] }))
  await writeFile(join(root, 'own.txt'), 'second project')
  const agent = await f.harness.create(SessionId('session-b'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const run = (owner: typeof agent, path: string) => f.ctx.tools.execute({ callId: ToolCallId(path), name: 'read', arguments: { path }, agent: owner, signal: new AbortController().signal })
  const results = await Promise.all([run(f.agent, 'own.txt'), run(agent, 'own.txt'), run(f.agent, join(root, 'own.txt')), run(agent, join(f.root, 'own.txt'))])
  expect(results[0]).toMatchObject({ isError: false, content: [{ type: 'text', text: 'own project' }] })
  expect(results[1]).toMatchObject({ isError: false, content: [{ type: 'text', text: 'second project' }] })
  expect(results.slice(2).every(result => result.isError)).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('logs only the owning project instructions and rejects an external instruction link', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'AGENTS.md'), 'Use blue wheels in this project.')
  await writeFile(join(f.workspace, 'AGENTS.md'), 'Private parent instructions.')
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the project file.' }] }))
  await f.agent.whenIdle()
  const events = JSON.stringify(f.agent.session.snapshotEvents())
  expect(events).toContain('Use blue wheels in this project.')
  const instructions = f.agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'runtime-context' && event.data.source.form === 'snapshot'
    ? event.data.source.sections.filter(section => section.name === 'rumi:project-instructions') : [])
  expect(instructions).toMatchSnapshot()
  expect(events).not.toContain('Private parent instructions.')
  expect(JSON.stringify(f.adapter.requests)).not.toContain('Private parent instructions.')
  await rm(join(f.root, 'AGENTS.md'))
  await symlink(join(f.workspace, 'AGENTS.md'), join(f.root, 'AGENTS.md'))
  const count = f.adapter.requests.length
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] }))
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(count)
  expect(JSON.stringify(f.agent.session.snapshotEvents())).not.toContain('Private parent instructions.')
})
