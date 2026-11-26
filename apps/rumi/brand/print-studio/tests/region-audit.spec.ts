/** Project startup and request-time region map validation. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { registerRegionAudits } from '../viewer/region-audit.js'

const mesh = `#usda 1.0
def Mesh "Wheel"
{
    point3f[] points = [(0,0,0), (1,0,0), (0,1,0)]
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0,1,2]
}
`
const hash = createHash('sha256').update(mesh).digest('hex')
const feature = { id: 'wheel', name: 'Wheel', location: { kind: 'surface', parts: [{ partPath: ['Wheel'] }] } }
const regionFile = (regions: object[], sourceHash = hash) => JSON.stringify({ sourceHash, regions })

it('cleans stored maps at startup and open and signals repair until a saved selection resolves', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rumi-naming-')))
  const root = join(workspace, randomUUID()), id = root.split('/').at(-1)!
  const directory = join(root, 'models', 'truck'), map = join(directory, 'model.regions.json')
  const model = 'models/truck/model.usda', session = { id: 'a', header: { cwd: root } }
  let dispose!: () => Promise<void>
  let preStep!: (args: object, next: () => Promise<void>) => Promise<void>
  let context!: (args: object) => string
  const ctx = {
    rumiProjectScope: { workspaceRoot: workspace }, logger: { warn: vi.fn() },
    effect(start: () => () => Promise<void>) { dispose = start() },
    on(_name: string, callback: typeof preStep) { preStep = callback },
    inject(_names: string[], register: (scope: object) => void) {
      register({ effect: (start: () => void) => start(), systemPrompt: {
        getContextOrder: () => 0, context: (entry: { text: typeof context }) => { context = entry.text },
      } })
    },
  }
  const agent = { session }, next = vi.fn(async () => {})
  const refresh = async () => { await preStep({ agent }, next); return context({ agent }) }
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, 'project.json'), JSON.stringify({ id, type: 'print', name: 'Truck', sessionIds: ['a'] }))
    await writeFile(join(root, model), mesh)
    await writeFile(map, regionFile([feature, { id: 'roof', name: 'Roof', boxes: [[0,0,0,1,1,1]] }]))
    const opened = registerRegionAudits(ctx)
    await vi.waitFor(() => expect(readFile(map)).rejects.toMatchObject({ code: 'ENOENT' }))
    expect(JSON.parse(await refresh())).toEqual({ missingRegionMaps: [model], regionCheckErrors: [] })

    await writeFile(map, regionFile([feature], '0'.repeat(64)))
    opened({ path: root })
    await vi.waitFor(() => expect(readFile(map)).rejects.toMatchObject({ code: 'ENOENT' }))
    await writeFile(map, regionFile([{ ...feature, location: { kind: 'surface', parts: [{ partPath: ['Wheel'], faceRanges: [[0, 2]] }] } }]))
    expect(JSON.parse(await refresh()).missingRegionMaps).toEqual([model])
    await expect(readFile(map)).rejects.toMatchObject({ code: 'ENOENT' })

    const saved = regionFile([feature])
    await writeFile(map, saved)
    expect(await refresh()).toBe('')
    expect(await readFile(map, 'utf8')).toBe(saved)

    await rm(map)
    const outside = join(workspace, 'outside.json')
    await writeFile(outside, '{}')
    await symlink(outside, map)
    expect(JSON.parse(await refresh())).toMatchObject({ missingRegionMaps: [], regionCheckErrors: [{ path: model }] })
    expect(await readFile(map, 'utf8')).toBe('{}')
  } finally {
    await dispose?.()
    await rm(workspace, { recursive: true, force: true })
  }
})

it('delivers the saved model path in the first agent request on an ordinary follow-up', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'rumi-naming-request-')))
  const ctx = new Context(), id = randomUUID(), cwd = join(workspace, id), sessionId = SessionId('truck-chat')
  try {
    const directory = join(cwd, 'models', 'truck')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'model.usda'), mesh)
    await writeFile(join(cwd, 'project.json'), JSON.stringify({ id, name: 'Truck', type: 'print', sessionIds: [sessionId] }))
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new MockAdapter([textResponse('Okay.')])
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
    registerRegionAudits({
      rumiProjectScope: { workspaceRoot: workspace }, effect: ctx.effect.bind(ctx),
      on: ctx.on.bind(ctx), inject: ctx.inject.bind(ctx), logger: ctx.logger,
    })
    const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' }, { cwd })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show me the truck.' }] }))
    await agent.whenIdle()
    const facts = adapter.requests[0]?.messages.filter(message => message.source.kind === 'runtime-context')
      .flatMap(message => message.content).filter(block => block.type === 'text' && block.text.includes('missingRegionMaps'))
      .flatMap(block => block.type === 'text' ? block.text.split('\n').filter(line => line.startsWith('{') && line.includes('missingRegionMaps')) : [])
    expect(facts).toMatchSnapshot()
    expect(JSON.stringify(facts)).toContain('models/truck/model.usda')
  } finally {
    await ctx.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
