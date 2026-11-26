import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'
/** A session's scene is edited by commands; geometry is read once and never rewritten by placement. */
import { createHash } from 'node:crypto'
import { createSource } from '../viewer/source.js'
import { validationState } from '../viewer/validation-state.js'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyViewer } from '../viewer/host.js'
import { encodeStl, parseStl } from '../viewer/stl.js'
import { legacyControls } from '../viewer/analog/control-spec.js'

function box(x = 12, y = 12, z = 2) {
  const points = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]]
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  return new Float32Array(triangles.flatMap(face => face.flatMap(vertex => points[vertex].flat())))
}

/** The same triangles as ASCII STL, which is what a test file on disk looks like. */
function stl(positions: Float32Array) {
  let out = 'solid model\n'
  for (let offset = 0; offset < positions.length; offset += 9) {
    out += 'facet normal 0 0 0\nouter loop\n'
    for (let vertex = 0; vertex < 3; vertex++) {
      out += `vertex ${positions[offset + vertex * 3]} ${positions[offset + vertex * 3 + 1]} ${positions[offset + vertex * 3 + 2]}\n`
    }
    out += 'endloop\nendfacet\n'
  }
  return new TextEncoder().encode(`${out}endsolid model\n`)
}

const owners: Context[] = []
const diagnosticRoots: string[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.fiber.dispose()))
  await Promise.all(diagnosticRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('documents creating multiple models and bringing a named entry into view', async () => {
  const f = fixture()
  expect({
    printer: await readFile(new URL('../skills/inspect-printer/SKILL.md', import.meta.url), 'utf8'),
    printJob: await readFile(new URL('../skills/prepare-print-job/SKILL.md', import.meta.url), 'utf8'),
    setup: await readFile(new URL('../skills/print-studio-setup/SKILL.md', import.meta.url), 'utf8'),
    fdm: await readFile(new URL('../skills/fdm-design/SKILL.md', import.meta.url), 'utf8'),
    joints: await readFile(new URL('../skills/printable-joints/SKILL.md', import.meta.url), 'utf8'),
    blender: await readFile(new URL('../skills/blender-modeling/SKILL.md', import.meta.url), 'utf8'),
    instructions: await readFile(new URL('../AGENTS_TEMPLATE.md', import.meta.url), 'utf8'),
    load: f.raw('viewer_load').description,
    surfaceAnalysis: f.raw('viewer_analyze_surfaces').description,
    cursor: f.raw('viewer_cursor_snapshot').description,
    highlight: f.raw('viewer_highlight').description,
    clarification: await readFile(new URL('../skills/clarify-mesh-changes/SKILL.md', import.meta.url), 'utf8'),
    regionNaming: await readFile(new URL('../skills/name-model-regions/SKILL.md', import.meta.url), 'utf8'),
    stateToolAvailable: Boolean(f.raw('mesh_state')),
    working: f.raw('viewer_working_model').description,
    analog: f.raw('viewer_controls').description,
    meshEdits: await readFile(new URL('../skills/mesh-edit-controls/SKILL.md', import.meta.url), 'utf8'),
    interactive: await readFile(new URL('../skills/control-widgets/SKILL.md', import.meta.url), 'utf8'),
    shaping: await readFile(new URL('../skills/built-in-mesh-operations/SKILL.md', import.meta.url), 'utf8'),
  }).toMatchSnapshot()
})

it('exposes Blender preview fields on the controls tool', () => {
  const tool = fixture().raw('viewer_controls')
  expect(tool.parameters.properties).toMatchObject({ finish: { enum: ['parameters', 'blender'] }, original: { type: 'string' }, edit: { type: 'string' } })
})

function fixture(source: Uint8Array = stl(box()), cwd = '/workspace', loadTimeoutMs = 1, validationConfig?: { validationStateDirectory: string }) {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const contexts = new Map<string, { text(context: object): string }>()
  const tools = new Map<string, any>() // The fixture captures dynamically registered JavaScript tool definitions.
  const owner = new Context()
  owners.push(owner)
  const ctx = {
    effect: owner.effect.bind(owner),
    inject: owner.inject.bind(owner),
    on: owner.on.bind(owner),
    attachments: { saveImage: async ({ data, mediaType, name }: { data: Uint8Array; mediaType: string; name: string }) => ({ attachmentId: 'sha256:test-cursor', bytes: data.length, mediaType, name, width: 1, height: 1 }) },
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => {} } },
    workingDirectory: { ensure: async () => cwd },
    sessionQuery: { observeSession: async () => ({ header: { cwd }, [Symbol.dispose]() {} }) },
    fs: { resolve: async (path: string) => ({ path, displayPath: path }), readBytes: async (_file: { path: string }) => source },
  }
  const diagnosticsDirectory = mkdtempSync(join(tmpdir(), 'rumi-viewer-diagnostics-'))
  diagnosticRoots.push(diagnosticsDirectory)
  applyViewer(ctx, defineTool, diagnosticsDirectory, loadTimeoutMs,
    validationConfig ? { validationTimeoutMs: 1000, mechanicsTimeoutMs: 1000, ...validationConfig } : undefined)
  owner.provide('systemPrompt', {
    getContextOrder: () => 210, getSectionOrder: () => 2600,
    section: () => () => {},
    context(value: { name: string; text(context: object): string }) {
      contexts.set(value.name, value)
      return () => { contexts.delete(value.name) }
    },
  })
  const meshState = async (sessionId = 'session-a') => {
    await vi.waitFor(() => expect(contexts.has('rumi:mesh-state')).toBe(true))
    return JSON.parse(contexts.get('rumi:mesh-state')!.text({ agent: { session: { id: sessionId } } })).meshState
  }
  const signal = () => new AbortController().signal
  const run = async (name: string, args: object = {}, sessionId = 'session-a') => JSON.parse(
    await tools.get(name).execute(args, { agent: { session: { id: sessionId } }, signal: signal() }),
  )
  return {
    routes, run, owner, ctx, diagnosticsDirectory, meshState, contexts,
    raw: (name: string) => tools.get(name),
    request: (path: string) => routes.get(path.split('?')[0])!(new Request(`http://rumi${path}`)),
    state: async (sessionId = 'session-a') => (await (await routes.get('/api/print-studio/viewer/state')!(
      new Request(`http://rumi/api/print-studio/viewer/state?sessionId=${sessionId}`),
    )).json()).scene,
    shapeFeedback: (id: string, url: string, body: object) => routes.get('/api/print-studio/viewer/shape-feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/shape-feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ id, url, ...body }),
      },
    )),
    dispose: () => owner.fiber.dispose(),
  }
}

it('discovers model folders, switches through UI and tool, and restores the selection after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-models-'))
  const f = fixture(undefined, root)
  try {
    for (const name of ['helmet', 'gloves']) {
      await mkdir(join(root, 'models', name), { recursive: true })
      await writeFile(join(root, 'models', name, 'model.js'), 'export function build(T) { return new T.Group() }')
      await writeFile(join(root, 'models', name, 'helper.js'), 'export const size = 1')
    }
    let state = await f.state()
    expect(state.catalogFailed).toBe(false)
    expect(state.models).toEqual([
      { name: 'gloves', path: 'models/gloves/model.js' },
      { name: 'helmet', path: 'models/helmet/model.js' },
    ])
    expect(state.selectedModel).toBe('models/gloves/model.js')
    const volume = { x: 256, y: 256, z: 256 }
    await f.run('viewer_load', { path: 'models/gloves/model.js', buildVolume: volume })
    const select = f.routes.get('/api/print-studio/viewer/select')!
    expect((await select(new Request('http://rumi/api/print-studio/viewer/select?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ path: 'models/helmet/model.js' }),
    }))).status).toBe(200)
    state = await f.state()
    expect(state.selectedModel).toBe('models/helmet/model.js')
    expect(state.design.path).toContain('helmet/model.js')
    expect(state.volume).toEqual(volume)
    await f.dispose()
    const restarted = fixture(undefined, root)
    expect(await restarted.state()).toMatchObject({ selectedModel: 'models/helmet/model.js', volume })
    const report = await restarted.run('viewer_load', { path: 'models/gloves/model.js' })
    expect(report.selectedModel).toBe('models/gloves/model.js')
    expect(report.volume).toEqual(volume)
    expect(JSON.parse(await readFile(join(root, '.rumi-viewer.json'), 'utf8')).path).toBe('models/gloves/model.js')
    await mkdir(join(root, 'models', 'boots'))
    await writeFile(join(root, 'models', 'boots', 'model.mjs'), 'export function build(T) { return new T.Group() }')
    expect((await restarted.state()).models).toHaveLength(3)
    await rm(join(root, 'models', 'gloves', 'model.js'))
    expect((await restarted.state()).design.error.kind).toBe('source')
    await restarted.dispose()
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('rejects unknown selection paths, excludes symlink entries, and reports broken restore state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-models-'))
  const f = fixture(undefined, root)
  try {
    await mkdir(join(root, 'source'))
    await writeFile(join(root, 'source', 'model.js'), 'export function build(T) { return new T.Group() }')
    await mkdir(join(root, 'models'))
    await symlink(join(root, 'source'), join(root, 'models', 'linked'))
    expect((await f.state()).models).toEqual([{ name: 'model', path: 'source/model.js' }])
    const response = await f.routes.get('/api/print-studio/viewer/select')!(new Request('http://rumi/api/print-studio/viewer/select?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ path: '../outside/model.js' }),
    }))
    expect(response.status).toBe(409)
    expect((await f.state()).selectedModel).toBe('source/model.js')
    await writeFile(join(root, '.rumi-viewer.json'), '{broken')
    expect((await f.state('new-session')).catalogFailed).toBe(true)
    await writeFile(join(root, '.rumi-viewer.json'), JSON.stringify({ version: 1, path: 'source/model.js', volume: { x: -1, y: 256, z: 256 } }))
    expect((await f.state('invalid-volume')).catalogFailed).toBe(true)
    await writeFile(join(root, '.rumi-viewer.json'), JSON.stringify({ version: 1, path: 'source/model.js' }))
    expect(await f.state('legacy-selection')).toMatchObject({ selectedModel: 'source/model.js', volume: null, catalogFailed: false })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('keeps an explicit selection after an overlapping automatic restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-model-race-'))
  const f = fixture(undefined, root)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    for (const name of ['a', 'b']) {
      await mkdir(join(root, 'models', name), { recursive: true })
      await writeFile(join(root, 'models', name, 'model.js'), 'export function build(T) { return new T.Group() }')
    }
    f.ctx.sessionQuery.observeSession = async () => {
      entered.resolve()
      await release.promise
      return { header: { cwd: root }, [Symbol.dispose]() {} }
    }
    const restore = f.state()
    await entered.promise
    const selection = f.run('viewer_load', { path: 'models/b/model.js' })
    release.resolve()
    await restore
    await selection
    expect((await f.state()).selectedModel).toBe('models/b/model.js')
    expect(JSON.parse(await readFile(join(root, '.rumi-viewer.json'), 'utf8')).path).toBe('models/b/model.js')
  } finally { release.resolve(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('opens a mesh into a scene the browser can draw and the agent can talk about', async () => {
  const f = fixture()
  const report = await f.run('mesh_open', { path: 'box.stl' })
  expect(report).toMatchObject({ objectCount: 1, status: 'review', volume: null })
  expect(report.objects[0]).toMatchObject({ name: 'box.stl', dimensions: { x: 12, y: 12, z: 2 } })

  const state = await f.state()
  expect(state.revision).toBe(1) // one addObject command
  expect(state.summary).toEqual({ status: 'review', errors: 0, warnings: 0 })
  expect(state.objects[0].matrix).toHaveLength(16)
  // The seat placement centres the mesh on the plate.
  expect(state.objects[0].matrix.slice(12, 15)).toEqual([-6, -6, 0])

  const response = await f.request(`/api/print-studio/viewer/model?sessionId=session-a&datablockId=${state.objects[0].datablockId}`)
  expect([...parseStl(await response.arrayBuffer())]).toEqual([...box()])
  expect((await f.request('/api/print-studio/viewer/model?sessionId=session-a&datablockId=nope')).status).toBe(404)
})

it('places a second copy of the same file on one datablock the browser already fetched', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const report = await f.run('mesh_open', { path: 'box.stl' })
  expect(report.objectCount).toBe(2)
  expect(report.objects[0].datablockId).toBe(report.objects[1].datablockId)
  expect(report.objects[0].id).not.toBe(report.objects[1].id)
})

it('reads the scene without changing it', async () => {
  const f = fixture()
  expect(await f.meshState()).toEqual({ status: 'unavailable', reason: 'viewer_not_initialized' })
  await f.run('mesh_open', { path: 'box.stl' })
  const report = await f.meshState()
  expect(report.objectCount).toBe(1)
  expect(report.objects[0].dimensions).toEqual({ x: 12, y: 12, z: 2 })
})

it('moves an object with a command instead of rewriting its geometry', async () => {
  const f = fixture()
  const opened = await f.run('mesh_open', { path: 'box.stl' })
  const before = await f.state()
  const moved = await f.run('mesh_transform', { scale: 2, rotate: { z: 90 } })
  expect(moved.objects[0].dimensions).toEqual({ x: 24, y: 24, z: 4 })
  expect(moved.objects[0].transform).toMatchObject({ scale: 2, rotate: { x: 0, y: 0, z: 90 } })
  const after = await f.state()
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.objects[0].datablockId).toBe(before.objects[0].datablockId)
  expect(after.objects[0].matrix).not.toEqual(before.objects[0].matrix)
  // Placements are seated, so the matrix changes even though the mesh does not.
  expect(before.objects[0].matrix).not.toEqual(after.objects[0].matrix)
  expect(opened.objects[0].id).toBe(after.objects[0].id)
})

it('keeps placement parts that were not given', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  await f.run('mesh_transform', { scale: 3 })
  const report = await f.run('mesh_transform', { rotate: { x: 45 } })
  expect(report.objects[0].transform).toMatchObject({ scale: 3, rotate: { x: 45, y: 0, z: 0 } })
})

it('checks the composed scene against a build volume', async () => {
  const f = fixture(stl(box(400, 12, 2)))
  const report = await f.run('mesh_open', { path: 'hull.stl', buildVolume: { x: 300, y: 320, z: 320 } })
  expect(report.volume).toEqual({ x: 300, y: 320, z: 320 })
  expect(report.status).toBe('blocked')
  expect(report.objects[0].suggested).toEqual({ scale: 0.75, rotate: false })
  const state = await f.state()
  expect(state.volume).toEqual({ x: 300, y: 320, z: 320 })
  expect(state.summary.status).toBe('blocked')
})

it('removes an object and reports what is left', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const report = await f.run('mesh_remove', {})
  expect(report.objectCount).toBe(0)
  expect((await f.state()).objects).toEqual([])
})

it('needs an explicit object once the scene holds more than one', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const second = await f.run('mesh_open', { path: 'box.stl' })
  await expect(f.run('mesh_transform', { scale: 2 })).rejects.toThrow('objectId')
  const moved = await f.run('mesh_transform', { objectId: second.objects[1].id, scale: 2 })
  expect(moved.objects[1].transform.scale).toBe(2)
  expect(moved.objects[0].transform.scale).toBe(1)
})

it('refuses a conversation-less call and a file that is not an STL', async () => {
  const f = fixture()
  await expect(f.raw('mesh_open').execute({ path: 'box.stl' }, { signal: new AbortController().signal })).rejects.toThrow('conversation')
  await expect(f.run('mesh_open', { path: 'box.obj' })).rejects.toThrow('STL')
  await expect(f.run('mesh_open', { path: '  ' })).rejects.toThrow('file path')
})

it('drops its routes and scenes when the plugin unloads', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  await f.dispose()
  expect(f.routes.size).toBe(0)
  await expect(f.run('mesh_open', { path: 'box.stl' })).rejects.toThrow('closed')
})


it('loads editable source and exposes placement, camera and revision-scoped errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-viewer-host-'))
  const f = fixture(undefined, root)
  try {
    await writeFile(join(root, 'model.js'), 'export function build(T) { return new T.Mesh(new T.BoxGeometry(1, 2, 3)) }')
    const loaded = await f.run('viewer_load', { path: 'model.js', buildVolume: { x: 300, y: 320, z: 320 } })
    expect(loaded.volume).toEqual({ x: 300, y: 320, z: 320 })
    expect(loaded.design).toMatchObject({ revision: 1, error: null, report: null })
    expect((await f.request(loaded.design.url)).headers.get('content-type')).toContain('javascript')
    await writeFile(join(root, 'overlay.stl'), stl(box()))
    const reference = { path: 'model.js', revision: loaded.design.revision, url: loaded.design.url,
      label: 'Upper region', regionName: 'Top edge', meshPath: 'overlay.stl' }
    const highlighting = f.run('viewer_highlight', reference)
    let scene
    await expect.poll(async () => { scene = await f.state(); return scene.design.highlight?.id }).toBeTruthy()
    const design = scene.design
    await f.routes.get('/api/print-studio/viewer/feedback')!(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: design.revision, url: design.url, transform: design.transform, highlightId: design.highlight.id }),
    }))
    const meshRoute = '/api/print-studio/viewer/highlight-mesh?sessionId=session-a&id=' + design.highlight.id
    expect(parseStl(await (await f.request(meshRoute)).arrayBuffer())).toEqual(box())
    expect((await f.request(meshRoute.replace('session-a', 'session-b'))).status).toBe(404)
    const highlighted = await highlighting
    expect({ status: highlighted.status, reason: highlighted.reason, message: highlighted.message }).toMatchSnapshot('acknowledged highlight result')
    expect(highlighted.status).toBe('rendered')
    expect(f.routes.has('/api/print-studio/viewer/region-reference')).toBe(false)
    const journal = join(f.diagnosticsDirectory, (await readdir(f.diagnosticsDirectory))[0])
    const trace = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(trace.map(row => row.type)).toEqual(expect.arrayContaining(['highlight.requested', 'viewer.state_delivered', 'viewer.feedback_received', 'highlight.acknowledged', 'highlight.settled']))
    expect(trace.find(row => row.type === 'viewer.feedback_received').data).toMatchObject({
      highlightId: highlighted.highlight.id, expectedHighlightId: highlighted.highlight.id,
      revisionMatches: true, urlMatches: true, transformMatches: true,
    })
    expect(trace.at(-1).data.status).toBe('rendered')
    expect((await f.meshState()).design.highlight).toEqual(highlighted.highlight)
    expect((await f.run('viewer_highlight', reference, 'another-session')).status).toBe('model_required')
    const hidden = f.run('viewer_highlight', { ...reference, path: loaded.design.path })
    await expect.poll(async () => {
      scene = await f.state()
      return scene.design.highlight?.id !== design.highlight.id && Boolean(scene.design.highlight?.id)
    }).toBe(true)
    const hiddenDesign = scene.design
    await f.routes.get('/api/print-studio/viewer/feedback')!(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: hiddenDesign.revision, url: hiddenDesign.url, transform: hiddenDesign.transform,
        requestedHighlightId: hiddenDesign.highlight.id, highlightStatus: 'highlight_hidden' }),
    }))
    expect(await hidden).toMatchObject({ status: 'not_rendered', reason: 'highlight_hidden' })
    expect((await f.run('viewer_highlight', { ...reference, revision: 99 })).status).toBe('stale_model')
    expect((await f.run('viewer_highlight', { ...reference, path: 'another-model.js' })).status).toBe('stale_model')
    expect((await f.run('viewer_highlight', { ...reference, meshPath: '', label: '' })).status).toBe('cleared')
    const placed = await f.run('viewer_transform', { scale: 2, rotate: { z: 90 } })
    expect(placed.design.transform).toMatchObject({ scale: 2, rotate: { z: 90 } })
    const camera = await f.run('viewer_camera', { azimuth: 45, elevation: 30 })
    expect(camera).toEqual({ path: placed.design.path, revision: placed.design.revision, url: placed.design.url,
      camera: expect.objectContaining({ azimuth: 45, elevation: 30 }) })
    const feedback = f.routes.get('/api/print-studio/viewer/feedback')!
    await feedback(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: 1, url: loaded.design.url, transform: placed.design.transform, error: 'Invalid geometry' }),
    }))
    expect((await f.meshState()).design.error).toEqual({ kind: 'build', message: 'Invalid geometry' })
    await expect(f.run('viewer_transform', { scale: -1 })).rejects.toThrow()
    expect((await f.meshState()).design.transform.scale).toBe(2)
  } finally {
    await f.dispose()
    await rm(root, { recursive: true, force: true })
  }
})


it('waits for an admitted load during Cordis disposal without publishing it afterwards', async () => {
  const f = fixture()
  let release!: (cwd: string) => void
  f.ctx.workingDirectory.ensure = () => new Promise<string>((resolve) => { release = resolve })
  const load = f.run('viewer_load', { path: 'model.js' })
  const failure = expect(load).rejects.toThrow('closed')
  let disposed = false
  const disposal = f.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  release('/workspace')
  await failure
  await disposal
  expect(f.routes.size).toBe(0)
})

it('returns a durable cursor image with its region through the tool output', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const pending = f.run('viewer_cursor_snapshot')
  let response
  await expect.poll(async () => {
    response = await (await f.request('/api/print-studio/viewer/state?sessionId=session-a')).json()
    return response.cursorRequest?.id
  }).toBeTruthy()
  const snapshot = {
    status: 'captured', capturedAt: '2026-11-03T20:00:00.000Z',
    identity: { sceneRevision: response.scene.revision, design: null },
    region: { objectId: response.scene.objects[0].id, partPath: ['box'], faceIndex: 0, worldPoint: [0, 0, 1], worldRadius: 2, modelLocalPoint: null, modelLocalBlob: null },
    camera: { position: [0, -20, 20], target: [0, 0, 0], up: [0, 0, 1], fov: 40, aspect: 1 },
    image: 'data:image/png;base64,cG5n',
  }
  const reply = await f.routes.get('/api/print-studio/viewer/cursor')!(new Request('http://rumi/api/print-studio/viewer/cursor?sessionId=session-a', {
    method: 'POST', body: JSON.stringify({ requestId: response.cursorRequest.id, snapshot }),
  }))
  expect(reply.status).toBe(200)
  const result = await pending
  expect(result.region).toEqual(snapshot.region)
  expect(result.image.attachmentId).toBe('sha256:test-cursor')
  expect(result.image).not.toHaveProperty('data')
  const blocks = f.raw('viewer_cursor_snapshot').output.render({}, JSON.stringify(result))
  expect(blocks[0].type).toBe('text')
  expect(blocks[1]).toEqual({ type: 'image', attachment: result.image })
  expect(await f.run('viewer_cursor_snapshot', {}, 'other-session')).toEqual({ status: 'viewer_unavailable', reason: 'viewer_not_open' })
})

it('highlights a feature by name when the named cursor supplies no pointing reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-named-feature-'))
  const f = fixture(undefined, root)
  try {
    const directory = join(root, 'models/hinge')
    await mkdir(directory, { recursive: true })
    const usd = '#usda 1.0\n'
    await writeFile(join(directory, 'model.usda'), usd)
    const sourceHash = createHash('sha256').update(usd).digest('hex')
    const feature = {
      id: 'pin-clearance', name: 'Pin clearance', aliases: ['pin gap'],
      description: 'The space that lets the pin turn.',
      location: { kind: 'point', point: [0, 0, 3] },
    }
    await writeFile(join(directory, 'model.regions.json'), JSON.stringify({ sourceHash, regions: [feature] }))
    const { design } = await f.state()
    const args = { path: 'models/hinge/model.usda', revision: design.revision, url: design.url, label: 'Pin clearance' }
    const capture = f.run('viewer_cursor_snapshot')
    const request = await vi.waitFor(async () => {
      const value = await (await f.request('/api/print-studio/viewer/state?sessionId=session-a')).json()
      expect(value.cursorRequest).toEqual({ id: expect.any(String) })
      return value
    })
    const noPointing = { status: 'viewer_unavailable', reason: 'named_regions' }
    const cursor = await f.routes.get('/api/print-studio/viewer/cursor')!(new Request(
      'http://rumi/api/print-studio/viewer/cursor?sessionId=session-a', {
        method: 'POST',
        body: JSON.stringify({ requestId: request.cursorRequest.id, snapshot: noPointing }),
      },
    ))
    expect(cursor.status).toBe(200)
    expect(await capture).toEqual(noPointing)
    await expect(f.run('viewer_highlight', { ...args, region: 'missing' })).resolves.toMatchObject({ status: 'unknown_region' })
    await expect(f.run('viewer_highlight', { ...args, region: 'pin gap', regionMapKey: 'stale' })).resolves.toMatchObject({ status: 'stale_region' })
    const highlighting = f.run('viewer_highlight', { ...args, region: 'PIN GAP' })
    const queued = await vi.waitFor(async () => {
      const { highlight } = (await f.state()).design
      expect(highlight).toMatchObject({ regionId: feature.id, regionName: feature.name, regionMapKey: design.regionMap.key })
      return highlight
    })
    expect(queued).not.toHaveProperty('meshPath')
    const report = { status: 'ok', dimensions: { x: 2, y: 2, z: 2 }, checks: [] }
    const feedback = await f.routes.get('/api/print-studio/viewer/feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ revision: design.revision, url: design.url, transform: design.transform, report, highlightId: queued.id }),
      },
    ))
    expect(feedback.status).toBe(200)
    expect(await highlighting).toMatchObject({ status: 'rendered', namedRegion: feature })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('highlights the exact triangles saved by an editable cursor capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-cursor-mesh-'))
  const f = fixture(undefined, root)
  try {
    await mkdir(join(root, 'models/cube'), { recursive: true })
    await writeFile(join(root, 'models/cube/model.usda'), '#usda 1.0\n')
    f.ctx.fs.readBytes = file => readFile(file.path)
    await f.state()
    const base = '/api/print-studio/viewer'
    const post = (route: string, value: object) => f.routes.get(`${base}/${route}`)!(new Request(
      `http://rumi${base}/${route}?sessionId=session-a`,
      { method: 'POST', body: JSON.stringify(value) },
    ))
    const pending = f.run('viewer_cursor_snapshot')
    const request = await vi.waitFor(async () => {
      const state = await (await f.request(`${base}/state?sessionId=session-a`)).json()
      expect(state.cursorRequest).toEqual({ id: expect.any(String) })
      return state
    })
    const { path, revision, url, transform } = request.scene.design
    const positions = box().slice(0, 18)
    const meshStl = Buffer.from(encodeStl(positions)).toString('base64')
    const point = [5, 5, 0]
    const selection = { partPath: ['Cube'], surfaceId: 1, mode: 'surface' }
    const snapshot = {
      status: 'captured', capturedAt: '2026-11-03T20:00:00.000Z',
      identity: { sceneRevision: request.scene.revision, design: { path, revision, url, transform } },
      region: { objectId: null, partPath: selection.partPath, faceIndex: 0, worldPoint: point, worldRadius: 2,
        modelLocalPoint: point, modelLocalBlob: { center: point, radii: [2, 2, 2], rotationDegrees: [0, 0, 0] }, selection },
      camera: { position: [0, 0, 20], target: [0, 0, 0], up: [0, 1, 0], fov: 40, aspect: 1 },
      image: 'data:image/png;base64,cG5n', meshStl,
    }
    expect((await post('cursor', { requestId: request.cursorRequest.id, snapshot })).status).toBe(200)
    const result = await pending
    expect(result).toMatchObject({ status: 'captured', mesh: { path: expect.stringMatching(/^\.rumi\/cursor-selections\/[^/]+\.stl$/u), triangleCount: 2 } })
    const output = f.raw('viewer_cursor_snapshot').output.render({}, JSON.stringify(result))
    expect(JSON.parse(output[0].text).mesh).toEqual(result.mesh)
    expect(output[0].text).not.toContain(meshStl)
    expect(parseStl(await readFile(join(root, result.mesh.path)))).toEqual(positions)

    const highlighting = f.run('viewer_highlight', { path, revision, url, label: 'Pinned surface', meshPath: result.mesh.path })
    const id = await vi.waitFor(async () => {
      const id = (await f.state()).design.highlight?.id
      expect(id).toBeTruthy()
      return id
    })
    const overlay = await f.request(`${base}/highlight-mesh?sessionId=session-a&id=${id}`)
    expect(parseStl(await overlay.arrayBuffer())).toEqual(positions)
    expect((await post('feedback', { revision, url, transform, highlightId: id })).status).toBe(200)
    expect(await highlighting).toMatchObject({ status: 'rendered', highlight: { meshPath: result.mesh.path, triangleCount: 2 } })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('unloads while a cursor request is waiting without retaining a tool or timer', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const pending = f.run('viewer_cursor_snapshot')
  await expect.poll(async () => (await (await f.request('/api/print-studio/viewer/state?sessionId=session-a')).json()).cursorRequest?.id).toBeTruthy()
  await f.dispose()
  expect(await pending).toEqual({ status: 'viewer_unavailable', reason: 'viewer_closed' })
  expect(f.routes.size).toBe(0)
})

it('supplies the captured cursor selection and image for the agent to interpret', async () => {
  const f = fixture()
  type Block = { type: 'text'; text: string } | { type: 'image'; attachment: object }
  type Contributor = {
    instructions(): string
    captureRequest(request: { sessionId: string; requestedAt: string; signal: AbortSignal }): Promise<Block[]>
  }
  let registered: Contributor | undefined
  f.owner.provide('liveVoice', { register(value: Contributor) { registered = value; return () => {} } })
  await f.run('mesh_open', { path: 'box.stl' })
  if (!registered) throw new Error('Pointing contributor did not register')
  expect(registered.instructions()).toContain('Delegate all requests about what to highlight or change in the model, including ambiguous requests.')
  const signal = new AbortController().signal
  const base = '/api/print-studio/viewer'
  const requestedAt = new Date().toISOString()
  const capture = registered.captureRequest({ sessionId: 'session-a', requestedAt, signal })
  const state = await vi.waitFor(async () => {
    const state = await (await f.request(`${base}/state?sessionId=session-a`)).json()
    expect(state.cursorRequest).toEqual({ id: expect.any(String) })
    return state
  })
  const selection = { partPath: ['box'], surfaceId: 1, mode: 'patch' }
  const snapshot = { status: 'captured', capturedAt: requestedAt,
    identity: { sceneRevision: state.scene.revision, design: null },
    region: { objectId: state.scene.objects[0].id, partPath: ['box'], faceIndex: 0,
      worldPoint: [1, 2, 3], worldRadius: 4, modelLocalBlob: null, selection },
    camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 40, aspect: 1 },
    image: 'data:image/png;base64,cG5n' }
  const result = await f.routes.get(`${base}/cursor`)!(new Request(`http://rumi${base}/cursor?sessionId=session-a`, {
    method: 'POST', body: JSON.stringify({ requestId: state.cursorRequest.id, snapshot }),
  }))
  expect(result.status).toBe(200)
  const content = await capture
  expect(content).toHaveLength(2)
  if (content[0]?.type !== 'text') throw new Error('Missing cursor reference')
  expect(JSON.parse(content[0].text)).toMatchObject({
    reference: 'cursor-at-start-of-spoken-request', requestedAt,
    snapshot: { identity: snapshot.identity, region: { selection } },
  })
  expect(content[1]).toMatchObject({ type: 'image', attachment: { attachmentId: 'sha256:test-cursor' } })
})

/** Drive the renderer response while exercising the real host review gate. */
async function prepareReviewed(f: ReturnType<typeof fixture>, args: { controls: { axes: { key: string }[] }[]; [key: string]: unknown }) {
  const expectations = args.controls.flatMap(control => control.axes.map(axis => ({ key: axis.key, effect: 'Change the selected profile', preserve: 'Keep adjacent parts fixed' })))
  const prepared = await f.run('viewer_controls', { ...args, expectations })
  expect(prepared.status).toBe('validation_required')
  expect(f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })).toContain('validation_required')
  expect((await f.state()).design.analog).toBeNull()
  await expect(f.run('viewer_controls', { action: 'present', id: prepared.id })).rejects.toThrow('Validate')
  const pending = f.run('viewer_controls', { action: 'validate', id: prepared.id })
  let request: any // Renderer request schema is owned by the JavaScript host.
  await vi.waitFor(async () => {
    const response = await f.routes.get('/api/print-studio/viewer/state')!(new Request('http://rumi/api/print-studio/viewer/state?sessionId=session-a'))
    request = (await response.json()).controlValidationRequest
    expect(request).toBeTruthy()
  })
  const result = { status: 'complete', neutralMaxDisplacementMm: 0, cases: request.cases.map((item: { id: string }) => ({ id: item.id, maxDisplacementMm: 2, rmsDisplacementMm: 1, affectedFraction: .1, image: 'data:image/png;base64,iVBORw0KGgo=' })) }
  const response = await f.routes.get('/api/print-studio/viewer/control-evidence')!(new Request('http://rumi/api/print-studio/viewer/control-evidence?sessionId=session-a', { method: 'POST', body: JSON.stringify({ id: request.id, result }) }))
  expect(response.status).toBe(200)
  const evidence = await pending
  expect(evidence.status).toBe('awaiting_review')
  expect(f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })).toContain('awaiting_review')
  expect(f.raw('viewer_controls').output.render({}, JSON.stringify(evidence)).filter((block: { type: string }) => block.type === 'image')).toHaveLength(request.cases.length)
  expect(evidence.images.length).toBe(request.cases.length)
  await expect(f.run('viewer_controls', { action: 'present', id: prepared.id })).rejects.toThrow('Validate')
  await f.run('viewer_controls', { action: 'review', id: prepared.id, evidenceId: evidence.evidenceId,
    assessments: expectations.map(e => ({ key: e.key, decision: 'accept', observation: 'The comparisons show smooth profile changes with adjacent parts fixed.' })),
    combined: { decision: 'accept', observation: 'The combined extremes preserve the intended profile.' },
  })
  return prepared.id
}

it('opens analog controls and freezes a fresh viewer capture without rewriting the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-analog-host-')), f = fixture(undefined, root, 500)
  try {
    const bytes = Buffer.from('#usda 1.0\n# preview\n')
    await vi.waitFor(() => expect(f.contexts.has('rumi:active-shape')).toBe(true))
    const editContext = f.contexts.get('rumi:active-shape')
    const path = join(root, 'model.usda'); await writeFile(path, bytes)
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const values = { amount: .65, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 }
    const reviewId = await prepareReviewed(f, { action: 'open', path: 'model.usda', url: design.url, revision: design.revision, operation: 'bulge', label: 'Back', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [], values, controls: legacyControls('bulge') })
    const opened = f.run('viewer_controls', { action: 'present', id: reviewId })
    let controls: { id: string }
    await vi.waitFor(async () => { controls = (await f.state()).design.analog; expect(controls).toBeTruthy() })
    const feedback = (body: object) => f.routes.get('/api/print-studio/viewer/shape-feedback')!(new Request('http://rumi/api/print-studio/viewer/shape-feedback?sessionId=session-a', { method: 'POST', body: JSON.stringify({ id: controls.id, url: design.url, ...body }) }))
    expect((await feedback({ status: 'rendered' })).status).toBe(200)
    expect(await opened).toMatchObject({ status: 'rendered' })
    expect(editContext?.text({ agent: { session: { id: 'session-a' } } })).toContain('Unresolved model edit:')
    expect(editContext?.text({ agent: { session: { id: 'other-session' } } })).toBe('')
    expect(editContext?.text({})).toBe('')
    const freezing = f.run('viewer_controls', { action: 'freeze', id: controls.id })
    await vi.waitFor(async () => expect((await f.state()).design.analog.freezeRequested).toBe(true))
    expect((await feedback({ status: 'frozen', sequence: 3, values: { ...values, amount: .87 } })).status).toBe(200)
    const result = await freezing
    expect(result).toMatchObject({ status: 'frozen', recipe: { values: { amount: .87 } } })
    expect(JSON.parse(await readFile(result.recipePath, 'utf8'))).toEqual(result.recipe)
    expect(await readFile(path)).toEqual(bytes)
    expect(await f.run('viewer_controls', { action: 'close', id: controls.id })).toEqual({ status: 'closed' })
    expect((await feedback({ status: 'adjusted', sequence: 4, values })).status).toBe(409)
    expect(editContext?.text({ agent: { session: { id: 'session-a' } } })).toBe('No temporary mesh controls are staged or presented.')
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})


it('declares work without switching the viewer and rejects missing or cancelled targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-work-target-'))
  const f = fixture(undefined, root)
  const agent = { session: { id: 'session-a' }, status: 'running' }
  const controller = new AbortController()
  const declare = (path?: string) => f.raw('viewer_working_model').execute(
    path === undefined ? {} : { path }, { agent, signal: controller.signal },
  )
  try {
    for (const name of ['cup', 'dragon']) {
      await mkdir(join(root, 'models', name), { recursive: true })
      await writeFile(join(root, 'models', name, 'model.js'), 'export function build() {}\n')
    }
    const before = await f.state()
    await declare('models/dragon/model.js')
    const during = await f.state()
    expect(during.selectedModel).toBe(before.selectedModel)
    expect(during.workingModels).toEqual(['models/dragon/model.js'])
    await expect(f.raw('viewer_transform').execute({ scale: 2 }, { agent, signal: controller.signal }))
      .rejects.toThrow(/viewer selection differs/u)
    expect((await f.state()).design.transform).toEqual(before.design.transform)
    await expect(declare('models/missing/model.js')).rejects.toThrow(/not found/u)
    expect((await f.state()).workingModels).toEqual(['models/dragon/model.js'])
    await declare()
    expect((await f.state()).workingModels).toEqual([])
    controller.abort()
    await expect(declare('models/cup/model.js')).rejects.toThrow()
    expect((await f.state()).workingModels).toEqual([])
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(['viewer_hidden', 'render_failed'])('reports control %s immediately and accepts a later visible render', async (status) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-control-feedback-')), f = fixture(undefined, root, 500)
  try {
    const path = join(root, 'model.usda')
    await writeFile(path, '#usda 1.0\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const reviewId = await prepareReviewed(f, { action: 'prepare', path, revision: design.revision, url: design.url,
      operation: 'bulge', label: 'Back', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [],
      values: { amount: .5, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 }, controls: legacyControls('bulge'),
    })
    const pending = f.run('viewer_controls', { action: 'present', id: reviewId })
    let id: string
    await vi.waitFor(async () => { id = (await f.state()).design.analog?.id; expect(id).toBeTruthy() })
    const feedback = f.shapeFeedback.bind(null, id!, design.url)
    expect((await feedback({ status, error: status === 'render_failed' ? 'Undeclared parameter' : undefined })).status).toBe(200)
    expect(await pending).toMatchObject({ status: 'not_rendered', reason: status, error: { kind: status } })
    expect((await f.state()).design.analog.rendered).toBe(false)
    expect((await feedback({ status: 'rendered' })).status).toBe(200)
    expect((await f.state()).design.analog).toMatchObject({ rendered: true, error: null })
    const freezing = f.run('viewer_controls', { action: 'freeze', id })
    await vi.waitFor(async () => expect((await f.state()).design.analog.freezeRequested).toBe(true))
    expect((await feedback({ status: 'viewer_hidden' })).status).toBe(200)
    expect(await freezing).toMatchObject({ status: 'not_rendered', reason: 'viewer_hidden' })
    expect((await f.state()).design.analog.frozen).toBe(false)
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('does not stage executable parameter previews', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-parameters-disabled-')), f = fixture(undefined, root)
  try {
    const path = join(root, 'model.js')
    await writeFile(path, 'export const parameters={size:60};export function build(){}\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    await expect(f.run('viewer_controls', { action: 'prepare', path, revision: design.revision, url: design.url,
      operation: 'parameters', label: 'Size', values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    })).rejects.toThrow('disabled')
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('rejects malformed preview metadata, external originals, and marker symlinks outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-marker-')), outside = await mkdtemp(join(tmpdir(), 'rumi-marker-outside-')), f = fixture(undefined, root)
  try {
    const path = join(root, 'model.js'), marker = join(root, '.rumi-preview.json')
    await writeFile(path, 'export const parameters={size:60};export function build(){}\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const open = () => f.run('viewer_controls', { action: 'open', path, revision: design.revision, url: design.url,
      operation: 'parameters', label: 'Size', values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    })
    await writeFile(marker, '{}'); await expect(open()).rejects.toThrow('Invalid .rumi-preview.json')
    const external = join(outside, 'original.blend'); await writeFile(external, 'original')
    await writeFile(marker, JSON.stringify({ original: external, edit: 'Set width.' }))
    await expect(open()).rejects.toThrow('inside the project')
    await rm(marker); await writeFile(join(outside, 'marker.json'), '{}'); await symlink(join(outside, 'marker.json'), marker)
    await expect(open()).rejects.toThrow('Preview marker must stay inside the project')
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

it('returns matching rendered measurements from viewer_load without another model round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-load-ready-'))
  const f = fixture(undefined, root, 8000)
  try {
    await writeFile(join(root, 'model.js'), 'export const parameters = { width: 12 }; export function build(T) { return new T.Group() }')
    const controller = new AbortController()
    let settled = false
    const loading = f.raw('viewer_load').execute({ path: 'model.js' }, {
      agent: { session: { id: 'session-a' } }, signal: controller.signal,
    }).then((result: string) => { settled = true; return JSON.parse(result) })
    await vi.waitFor(async () => expect((await f.meshState()).design?.url).toBeTruthy())
    const scene = await f.state()
    expect(settled).toBe(false)
    const response = await f.routes.get('/api/print-studio/viewer/feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({
          revision: scene.design.revision, url: scene.design.url, transform: scene.design.transform,
          volume: scene.volume, loadStatus: 'ready', parameters: { width: 12 },
          report: { status: 'ok', dimensions: { x: 12, y: 12, z: 2 }, checks: [] },
        }),
      },
    ))
    expect(response.status).toBe(200)
    const result = await loading
    expect(result).toMatchObject({ load: { status: 'ready' }, design: {
      revision: scene.design.revision, url: scene.design.url, parameters: { width: 12 },
      report: { dimensions: { x: 12, y: 12, z: 2 } },
    } })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each([
  { loadStatus: 'build_failed', error: 'Missing geometry', expected: 'build_failed' },
  { loadStatus: 'viewer_hidden', expected: 'viewer_hidden' },
])('returns $expected from matching load feedback', async ({ loadStatus, error, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-load-outcome-'))
  const f = fixture(undefined, root, 8000)
  try {
    await writeFile(join(root, 'model.js'), 'export function build(T) { return new T.Group() }')
    const loading = f.run('viewer_load', { path: 'model.js' })
    await vi.waitFor(async () => expect((await f.meshState()).design?.url).toBeTruthy())
    const scene = await f.state()
    const event = await f.request('/api/print-studio/viewer/events?sessionId=session-a&after=0')
    expect((await event.json()).version).toBeGreaterThan(0)
    await f.routes.get('/api/print-studio/viewer/feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ revision: scene.design.revision, url: scene.design.url,
          transform: scene.design.transform, volume: scene.volume, loadStatus, error,
          ...error ? {} : { report: { status: 'ok', dimensions: { x: 12, y: 12, z: 2 }, checks: [] } },
        }),
      },
    ))
    const result = await loading
    expect(result.load.status).toBe(expected)
    expect(result.design.error).toEqual(error ? { kind: 'build', message: error } : null)
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('ignores stale feedback and supersedes a load when its source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-load-stale-'))
  const f = fixture(undefined, root, 8000)
  try {
    await writeFile(join(root, 'model.js'), 'export function build(T) { return new T.Group() }')
    let settled = false
    const loading = f.run('viewer_load', { path: 'model.js' }).then((result) => { settled = true; return result })
    await vi.waitFor(async () => expect((await f.meshState()).design?.url).toBeTruthy())
    const scene = await f.state()
    const feedback = f.routes.get('/api/print-studio/viewer/feedback')!
    for (const identity of [{ url: '/old/model.js' }, { revision: scene.design.revision + 1 }, { volume: { x: 1, y: 1, z: 1 } }]) {
      await feedback(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ revision: scene.design.revision, url: scene.design.url,
          transform: scene.design.transform, volume: scene.volume, ...identity, loadStatus: 'ready',
          report: { status: 'ok', dimensions: { x: 12, y: 12, z: 2 }, checks: [] },
        }),
      }))
      expect(settled).toBe(false)
    }
    await writeFile(join(root, 'model.js'), 'export function build(T) { return new T.Mesh() }')
    await f.state()
    await f.state()
    const result = await loading
    expect(result.load.status).toBe('superseded')
    expect(result.load.requested.url).toBe(scene.design.url)
    expect(result.design.report).toBeNull()
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})


it('shows unvalidated models without requiring a passing report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-candidate-'))
  const f = fixture(undefined, root, 1000, { validationStateDirectory: join(root, 'validation-state') })
  try {
    await mkdir(join(root, 'models/car'), { recursive: true })
    await writeFile(join(root, 'models/car/model.js'), 'export function build(T) { return new T.Group() }')
    const loaded = await f.run('viewer_load', { path: 'models/car/model.js' })
    expect(loaded.load.status).toBe('timeout')
    expect((await f.state()).design.path).toContain('models/car/model.js')
    const context = await f.meshState()
    expect(context.design.path).toContain('models/car/model.js')
    expect(context.displayedDesign.path).toContain('models/car/model.js')
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})


it('routes pointing, highlights and feedback to current edits regardless of validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-accepted-pointing-'))
  const directory = join(root, 'validation-state')
  const f = fixture(undefined, root, 1000, { validationStateDirectory: directory })
  try {
    const path = join(root, 'models/car/model.js')
    await mkdir(join(root, 'models/car'), { recursive: true })
    await writeFile(path, 'export const revision = "accepted"')
    const source = await createSource(f.ctx, path, root)
    source.transform({ position: { x: 10, y: 0, z: 0 } })
    const initial = source.state()
    const fingerprint = createHash('sha256').update(JSON.stringify([3, initial.contentHash, initial.transform, null, undefined, undefined])).digest('hex')
    const storage = validationState(directory, root, 'models/car/model.js')
    await storage.write({ movements: [] }, { fingerprint, state: initial, volume: null, source: source.snapshot() })
    await source.dispose()
    expect((await f.state()).design.contentHash).toBe(initial.contentHash)
    expect((await f.run('viewer_load', { path: 'models/car/model.js' })).load.status).toBe('timeout')
    await writeFile(path, 'export const revision = "candidate"')
    await f.state()
    const displayed = (await f.state()).design
    expect(displayed.contentHash).not.toBe(initial.contentHash)
    expect((await f.meshState()).design.contentHash).not.toBe(initial.contentHash)
    const pending = f.run('viewer_cursor_snapshot')
    let response: any // Runtime route responses are JSON shared with the JavaScript client.
    await expect.poll(async () => {
      response = await (await f.request('/api/print-studio/viewer/state?sessionId=session-a')).json()
      return response.cursorRequest?.id
    }).toBeTruthy()
    const identity = { sceneRevision: response.scene.revision, design: {
      path: displayed.path, revision: displayed.revision, url: displayed.url, transform: displayed.transform,
    } }
    const blob = { center: [0, 0, 0], radii: [2, 2, 2], rotationDegrees: [0, 0, 0] }
    const snapshot = { status: 'captured', capturedAt: '2026-11-03T20:00:00.000Z', identity,
      region: { objectId: null, partPath: ['body'], faceIndex: 0, worldPoint: [0, 0, 0], worldRadius: 2, modelLocalBlob: blob },
      camera: { position: [0, -20, 20], target: [0, 0, 0], up: [0, 0, 1], fov: 40, aspect: 1 }, image: 'data:image/png;base64,cG5n' }
    const send = (route: string, value: object) => f.routes.get(`/api/print-studio/viewer/${route}`)!(new Request(`http://rumi/api/print-studio/viewer/${route}?sessionId=session-a`, { method: 'POST', body: JSON.stringify(value) }))
    expect((await send('cursor', { requestId: response.cursorRequest.id, snapshot })).status).toBe(200)
    expect((await pending).status).toBe('captured')
    await writeFile(join(root, 'overlay.stl'), stl(box()))
    const highlighting = f.run('viewer_highlight', { path: displayed.path, revision: displayed.revision, url: displayed.url, label: 'Body', meshPath: 'overlay.stl' })
    let highlighted: any // Viewer route is an untyped JSON boundary in this fixture.
    await expect.poll(async () => { highlighted = (await f.state()).design; return highlighted.highlight?.id }).toBeTruthy()
    const report = { status: 'ok', dimensions: { x: 2, y: 2, z: 2 }, checks: [] }
    expect((await send('feedback', { revision: displayed.revision, url: displayed.url, transform: displayed.transform, report, highlightId: highlighted.highlight.id })).status).toBe(200)
    expect((await highlighting).status).toBe('rendered')
    expect((await f.state()).design.report).toEqual(report)
    expect((await f.meshState()).design.report).toEqual(report)
    await f.run('viewer_camera', { azimuth: 20, elevation: 30 })
    expect((await f.state()).design.camera).toMatchObject({ azimuth: 20, elevation: 30 })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('shows imported STL objects before validation completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-stl-candidate-'))
  const f = fixture(undefined, root, 1000, { validationStateDirectory: join(root, 'validation-state') })
  try {
    await f.run('mesh_open', { path: 'box.stl' })
    expect((await f.state()).objects).toHaveLength(1)
    expect((await f.meshState()).objects).toHaveLength(1)
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('evicts accepted validation snapshots together with inactive preview scenes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-scene-eviction-'))
  const directory = join(root, 'validation-state')
  const f = fixture(undefined, root, 1000, { validationStateDirectory: directory })
  try {
    const path = join(root, 'models/car/model.usda')
    await mkdir(join(root, 'models/car'), { recursive: true })
    await writeFile(path, '#usda 1.0\n')
    const source = await createSource(f.ctx, path, root)
    try {
      const storage = validationState(directory, root, 'models/car/model.usda')
      await storage.write({ movements: [] }, { fingerprint: 'a'.repeat(64), state: source.state(), volume: null, source: source.snapshot() })
    } finally { await source.dispose() }
    for (let index = 0; index < 9; index++) await f.state(`session-${index}`)
    await expect.poll(() => [...f.routes.keys()].filter(path => path.startsWith('/api/print-studio/viewer/source/')).length).toBe(16)
    expect((await f.meshState('session-0')).validation.models).toEqual([])
    expect((await f.meshState('session-8')).validation.models[0].acceptedFingerprint).toBe('a'.repeat(64))
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('loads project field data and rejects paths outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-fields-host-')), outside = await mkdtemp(join(tmpdir(), 'rumi-fields-outside-')), f = fixture(undefined, root, 500)
  try {
    const path = join(root, 'model.usda'); await writeFile(path, '#usda 1.0\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const offsets = Array(81).fill(0); offsets[41] = 10
    const fields = [{ key: 'crown', origin: [-10,-10,-10], spacing: [10,10,10], dimensions: [3,3,3], offsets }]
    await writeFile(join(root, 'fields.json'), JSON.stringify(fields))
    const args = { action: 'open', path, revision: design.revision, url: design.url, operation: 'fields', label: 'Crown', parts: ['Shell'], values: { crown: 0 }, fieldsPath: 'fields.json', controls: [{ kind: 'slider', label: 'Height', axes: [{ key: 'crown', min: -1, max: 1, step: .01, reset: 0 }] }] }
    await writeFile(join(outside, 'fields.json'), JSON.stringify(fields))
    await expect(f.run('viewer_controls', { ...args, fieldsPath: join(outside, 'fields.json') })).rejects.toThrow('inside the project')
    const reviewId = await prepareReviewed(f, args)
    const pending = f.run('viewer_controls', { action: 'present', id: reviewId })
    let id = ''
    await vi.waitFor(async () => { id = (await f.state()).design.analog?.id; expect(id).toBeTruthy() })
    await f.shapeFeedback(id, design.url, { status: 'rendered' })
    const rendered = await pending
    expect(rendered).toMatchObject({ status: 'rendered', controls: { fields: [{ offsetCount: 81 }] } })
    expect(rendered.controls.fields[0].offsets).toBeUndefined()
    const context = await f.meshState()
    expect(context.design.analog.fields[0].offsets).toBeUndefined()
    expect((await f.state()).design.analog.fields).toEqual(fields)
    await writeFile(join(root, 'fields.json'), '[]')
    expect((await f.state()).design.analog.fields).toEqual(fields)
    await f.run('viewer_controls', { action: 'close', id })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})


it('records a refused presentation and repeats the pending review in the next agent request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-control-turn-')), f = fixture(undefined, root), ctx = new Context()
  try {
    const path = join(root, 'model.usda'); await writeFile(path, '#usda 1.0\n')
    await f.run('viewer_load', { path })
    await vi.waitFor(() => expect(f.contexts.has('rumi:active-shape')).toBe(true))
    const design = (await f.state()).design
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.effect(() => ctx.tools.register(f.raw('viewer_controls')))
    ctx.effect(() => ctx.systemPrompt.context({ name: 'test:pending-controls', order: 210, required: true,
      text: context => f.contexts.get('rumi:active-shape')!.text(context),
    }))
    const adapter = new MockAdapter([
      toolCallResponse('prepare', 'viewer_controls', { action: 'prepare', path, revision: design.revision, url: design.url,
        operation: 'bulge', label: 'Profile', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [],
        values: { amount: .5, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 },
        controls: [{ kind: 'slider', label: 'Depth', axes: [{ key: 'amount', min: 0, max: 1, reset: .5, step: .1 }] }],
        expectations: [{ key: 'amount', effect: 'Change profile depth', preserve: 'Keep adjacent geometry fixed' }],
      }),
      (options) => {
        expect(JSON.stringify(options.messages)).toContain('validation_required')
        const state = f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })
        const id = /"id":"([^" ]+)"/.exec(state)![1]
        return toolCallResponse('skip-validation', 'viewer_controls', { action: 'present', id })
      },
      textResponse('Validation is required before presenting these controls.'),
    ])
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const agent = await harness.create(SessionId('session-a'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Let me adjust the profile.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
    expect(results).toHaveLength(2)
    expect(results[1]!.isError).toBe(true)
    expect(results[1]!.content).toMatchSnapshot()
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('validation_required')
    expect((await f.state()).design.analog).toBeNull()
  } finally { await ctx.fiber.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})


it('retains reviewed controls when reloading identical bytes and invalidates them for changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-control-reload-')), f = fixture(undefined, root, 500)
  try {
    const path = join(root, 'model.usda'); await writeFile(path, '#usda 1.0\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const id = await prepareReviewed(f, { action: 'prepare', path, revision: design.revision, url: design.url,
      operation: 'bulge', label: 'Profile', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [],
      values: { amount: .5, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 }, controls: legacyControls('bulge') })
    const before = (await f.state()).design
    const sidecar = JSON.stringify({ sourceHash: before.contentHash, regions: [
      { id: 'panel', name: 'Panel', location: { kind: 'surface', parts: [{ partPath: ['Missing'] }] } },
    ] })
    const key = createHash('sha256').update(sidecar).digest('hex')
    await writeFile(join(root, 'model.regions.json'), sidecar)
    const reload = f.run('viewer_load', { path })
    let after: typeof before
    await vi.waitFor(async () => { after = (await f.meshState()).design; expect(after.renderRequest).toBeTruthy() })
    expect(after!.url).toBe(design.url)
    expect(after!.regionMap.key).toBe(key)
    expect(after!.controlReview).toEqual(before.controlReview)
    await f.routes.get('/api/print-studio/viewer/feedback')!(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: before.revision, url: before.url, transform: before.transform, volume: null, error: 'Stale renderer failure', loadStatus: 'build_failed' }),
    }))
    expect((await f.state()).design.error).toBeNull()
    const response = await f.routes.get('/api/print-studio/viewer/feedback')!(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: after!.revision, url: after!.url, renderRequest: after!.renderRequest,
        transform: after!.transform, volume: null, loadStatus: 'ready', report: { status: 'ok', dimensions: { x: 1, y: 1, z: 1 }, checks: [] },
        regionResolution: { key, unresolvedIds: ['panel'] } }),
    }))
    expect(response.status).toBe(200)
    expect(await reload).toMatchObject({ load: { status: 'ready' }, design: { regionStatus: 'invalid', regionError: expect.stringContaining('panel') } })
    expect((await f.state()).design.controlReview).toMatchObject({ id, status: 'approved' })
    await writeFile(path, '#usda 1.0\n# changed geometry\n')
    await f.run('viewer_load', { path })
    expect((await f.state()).design.controlReview).toBeNull()
    await expect(f.run('viewer_controls', { action: 'review', id, evidenceId: before.controlReview.evidenceId })).rejects.toThrow('no longer staged')
    expect(f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })).toBe('No temporary mesh controls are staged or presented.')
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})


it('records retained retry instructions and reports when controls have been cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-control-retry-turn-')), f = fixture(undefined, root), ctx = new Context()
  try {
    const path = join(root, 'model.usda'); await writeFile(path, '#usda 1.0\n')
    await f.run('viewer_load', { path })
    await vi.waitFor(() => expect(f.contexts.has('rumi:active-shape')).toBe(true))
    const design = (await f.state()).design
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    for (const name of ['viewer_controls', 'viewer_load']) ctx.effect(() => ctx.tools.register(f.raw(name)))
    ctx.effect(() => ctx.systemPrompt.context({ name: 'test:pending-controls', order: 210, required: true,
      text: context => f.contexts.get('rumi:active-shape')!.text(context),
    }))
    let id = ''
    const adapter = new MockAdapter([
      toolCallResponse('prepare', 'viewer_controls', { action: 'prepare', path, revision: design.revision, url: design.url,
        operation: 'bulge', label: 'Profile', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [],
        values: { amount: .5, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 },
        controls: [{ kind: 'slider', label: 'Depth', axes: [{ key: 'amount', min: 0, max: 1, reset: .5, step: .1 }] }],
        expectations: [{ key: 'amount', effect: 'Change profile depth', preserve: 'Keep adjacent geometry fixed' }],
      }),
      () => {
        const state = f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })
        id = /"id":"([^" ]+)"/.exec(state)![1]!
        return toolCallResponse('validate', 'viewer_controls', { action: 'validate', id })
      },
      (options) => {
        expect(JSON.stringify(options.messages)).toContain(`Prepared controls ${id} are retained`)
        return toolCallResponse('reload', 'viewer_load', { path })
      },
      (options) => {
        const current = f.contexts.get('rumi:active-shape')!.text({ agent: { session: { id: 'session-a' } } })
        expect(current).toContain(`"id":"${id}"`)
        expect(current).toContain('validation_required')
        expect(JSON.stringify(options.messages)).toContain('validation_required')
        return toolCallResponse('retry', 'viewer_controls', { action: 'validate', id })
      },
      () => toolCallResponse('close', 'viewer_controls', { action: 'close', id }),
      (options) => {
        expect(JSON.stringify(options.messages)).toContain('No temporary mesh controls are staged or presented.')
        return toolCallResponse('stale', 'viewer_controls', { action: 'present', id })
      },
      textResponse('The controls were cleared. Prepare and validate them again before presentation.'),
    ])
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
    const agent = await harness.create(SessionId('session-a'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retry the profile controls.' }] }))
    await agent.whenIdle()
    const failures = agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' && event.data.message.isError ? [event.data.message.content] : [])
    expect(failures).toHaveLength(3)
    expect(JSON.parse(JSON.stringify(failures).replaceAll(id, '<review-id>'))).toMatchSnapshot()
    expect((await f.state()).design.controlReview).toBeNull()
  } finally { await ctx.fiber.dispose(); await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('discovers a saved part’s selectable surfaces and exports the viewer triangle order without a cursor', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rumi-surface-analysis-'))
  const f = fixture(undefined, cwd)
  try {
    const path = 'hinge.usda'
    const bytes = await readFile(new URL('./fixtures/robot.usda', import.meta.url))
    await writeFile(join(cwd, path), bytes)
    const inventory = await f.run('viewer_analyze_surfaces', { path })
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    const partPath = ['Model', 'Door']
    expect(inventory).toMatchObject({ sourceHash, status: 'analyzed', total: 2, nextOffset: null })
    expect(inventory.parts).toContainEqual({ partPath, triangles: 12, surfaceCount: 6, boundsMm: [15, -10, -10, 35, 10, 10] })
    const features = await f.run('viewer_analyze_surfaces', { path, sourceHash, partPath, includeMesh: true })
    expect(features).toMatchObject({ sourceHash, partPath, total: 6, nextOffset: null, mesh: { triangleCount: 12 } })
    expect(features.surfaces).toContainEqual({ surfaceId: 1, triangles: 2, areaMm2: 400, centerMm: [15, 0, 0],
      boundsMm: [15, -10, -10, 15, 10, 10], meanNormal: [-1, 0, 0] })
    const { parseUsdModel } = await import('../viewer/viewport/usd.js')
    const { createNamedRegionIndex, createNamedRegionVisual } = await import('../viewer/viewport/named-regions.js')
    const { Group, Scene, Vector3 } = await import('three')
    const { root } = await parseUsdModel(Uint8Array.from(bytes).buffer)
    const placement = new Group().add(root)
    const region = (id: string, selector: object) => ({ id, location: { kind: 'surface', parts: [{ partPath, ...selector }] } })
    const regions = createNamedRegionIndex(root, placement, [region('ordered', { faceRanges: [[2, 5]] }), region('panel', { surfaceIds: [1] })])
    const whole = parseStl(await readFile(join(cwd, features.mesh.path)))
    const scene = new Scene().add(placement)
    function displayedTriangles(id: string) {
      const preview = createNamedRegionVisual(regions.get(id), scene, placement, 0x9ab9e1, (node: import('three').Mesh) => node, 0.5)
      try {
        preview.update()
        preview.root.updateMatrixWorld(true)
        const overlay = preview.root.children[0] as import('three').Mesh
        const positions = overlay.geometry.getAttribute('position')
        const point = new Vector3()
        const triangles = new Float32Array(positions.count * 3)
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(overlay.matrixWorld).toArray(triangles, i * 3)
        }
        return triangles
      } finally { preview.dispose() }
    }
    expect(displayedTriangles('ordered')).toEqual(whole.slice(2 * 9, 5 * 9))
    expect(displayedTriangles('panel')).toHaveLength(2 * 9)
    expect(await f.run('viewer_analyze_surfaces', { path, sourceHash: '0'.repeat(64), partPath })).toMatchObject({ status: 'stale_model', sourceHash })
    await expect(f.run('viewer_analyze_surfaces', { path, partPath: ['missing'] })).rejects.toThrow(/Copy the array/)
    const outside = new URL('./fixtures/robot.usda', import.meta.url)
    await symlink(outside, join(cwd, 'outside.usda'))
    await expect(f.run('viewer_analyze_surfaces', { path: 'outside.usda' })).rejects.toThrow(/inside the project/)
  } finally {
    await f.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('pages disconnected areas of one saved mesh by decreasing triangle area', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rumi-surface-pages-'))
  const f = fixture(undefined, cwd)
  try {
    const path = 'terrain.usda'
    const faces = Array.from({ length: 29 }, (_, i) => i)
    const points = faces.flatMap(i => [`(${i * 2}, 0, 0)`, `(${i * 2 + 1}, 0, 0)`, `(${i * 2}, ${i + 1}, 0)`])
    const indices = faces.flatMap(i => [i * 3, i * 3 + 1, i * 3 + 2])
    await writeFile(join(cwd, path), `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Z"
)
def Mesh "Islands"
{
    point3f[] points = [${points.join(', ')}]
    int[] faceVertexCounts = [${faces.map(() => 3).join(', ')}]
    int[] faceVertexIndices = [${indices.join(', ')}]
}
`)
    const args = { path, partPath: ['Islands'] }
    const page = await f.run('viewer_analyze_surfaces', args)
    expect(page).toMatchObject({ total: 29, nextOffset: 24 })
    expect(page.surfaces[0]).toMatchObject({ surfaceId: 29, triangles: 1, areaMm2: 14_500_000 })
    const rest = await f.run('viewer_analyze_surfaces', { ...args, sourceHash: page.sourceHash, offset: page.nextOffset })
    expect(rest).toMatchObject({ total: 29, nextOffset: null })
    expect([...page.surfaces, ...rest.surfaces].map(row => row.surfaceId)).toEqual(faces.map(i => 29 - i))

    await writeFile(join(cwd, 'terrain.regions.json'), JSON.stringify({ sourceHash: page.sourceHash,
      regions: [{ id: 'origin', name: 'Origin', location: { kind: 'point', point: [0, 0, 0] } }] }))
    const auditArgs = { ...args, coverage: true }
    const auditPage = await f.run('viewer_analyze_surfaces', auditArgs)
    expect(auditPage).toMatchObject({ total: 29, nextOffset: 24, coverage: { uncoveredTriangles: 29 } })
    expect(auditPage.surfaces[0]).toMatchObject({ surfaceId: 29, surfaceIds: [29] })
    await expect(f.run('viewer_analyze_surfaces', { ...auditArgs, offset: 24 })).rejects.toThrow(/sourceHash and regionMapKey/)
    const auditRest = await f.run('viewer_analyze_surfaces', {
      ...auditArgs, sourceHash: auditPage.sourceHash, regionMapKey: auditPage.regionMapKey, offset: auditPage.nextOffset,
    })
    expect(auditRest).toMatchObject({ total: 29, nextOffset: null })
    expect(auditRest.surfaces.map(row => row.surfaceId)).toEqual([5, 4, 3, 2, 1])
  } finally {
    await f.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('audits the uncovered faces of a saved map without opening the viewer', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rumi-region-coverage-'))
  const f = fixture(undefined, cwd)
  try {
    const path = 'panel.usda'
    const partPath = ['Panel']
    const mapPath = join(cwd, 'panel.regions.json')
    const segments = 20
    const points = Array.from({ length: segments + 1 }, (_, i) => [`(${i}, 0, 0)`, `(${i}, 1, 0)`]).flat()
    const indices = Array.from({ length: segments }, (_, i) => {
      const a = i * 2
      return [a, a + 2, a + 3, a, a + 3, a + 1]
    }).flat()
    const usd = `#usda 1.0
(
    metersPerUnit = 0.001
    upAxis = "Z"
)
def Mesh "Panel"
{
    point3f[] points = [${points.join(', ')}]
    int[] faceVertexCounts = [${Array(segments * 2).fill(3).join(', ')}]
    int[] faceVertexIndices = [${indices.join(', ')}]
}
`
    await writeFile(join(cwd, path), usd)
    const sourceHash = createHash('sha256').update(usd).digest('hex')
    const args = { path, coverage: true }
    const region = (id: string, faceRanges: number[][]) => ({
      id, name: id, location: { kind: 'surface', parts: [{ partPath, faceRanges }] },
    })
    const saveMap = (regions: object[], hash = sourceHash) => writeFile(mapPath, JSON.stringify({ sourceHash: hash, regions }))
    expect(await f.run('viewer_analyze_surfaces', args)).toMatchObject({ status: 'missing_region_map' })
    const partial = region('panel-part', [[0, 1], [3, 4]])
    const other = region('corner', [[0, 1]])
    await saveMap([partial], '0'.repeat(64))
    expect(await f.run('viewer_analyze_surfaces', args)).toMatchObject({ status: 'outdated_region_map' })
    await saveMap([partial, other, { ...other, id: 'corner-detail', parentId: 'panel-part' },
      { id: 'clearance', name: 'Clearance', location: { kind: 'point', point: [0, 0, 0] } }])
    const audit = await f.run('viewer_analyze_surfaces', args)
    expect(audit).toMatchObject({
      status: 'analyzed', sourceHash,
      coverage: { triangles: 40, uncoveredTriangles: 38, areaMm2: 20, uncoveredAreaMm2: 19 },
      total: 1, parts: [{ partPath, uncoveredSurfaceCount: 1, uncoveredTriangles: 38 }], nextOffset: null,
    })
    const detailArgs = { ...args, partPath, sourceHash, regionMapKey: audit.regionMapKey }
    const details = await f.run('viewer_analyze_surfaces', detailArgs)
    expect(details.surfaces).toEqual([{
      surfaceId: 39, triangles: 38, surfaceTriangles: 40, areaMm2: 19,
      boundsMm: [0, 0, 0, 20, 1, 0], faceRanges: [[1, 3], [4, 40]],
    }])

    const striped = region('stripes', Array.from({ length: segments }, (_, i) => [i * 2, i * 2 + 1]))
    await saveMap([striped])
    expect(await f.run('viewer_analyze_surfaces', detailArgs)).toMatchObject({ status: 'stale_region_map' })
    const stripes = await f.run('viewer_analyze_surfaces', { ...args, partPath })
    expect(stripes.surfaces[0]).toMatchObject({ triangles: 20, faceRangesPath: expect.any(String) })
    expect(JSON.parse(await readFile(join(cwd, stripes.surfaces[0].faceRangesPath), 'utf8')))
      .toEqual(Array.from({ length: segments }, (_, i) => [i * 2 + 1, i * 2 + 2]))

    await saveMap([region('overshoots', [[0, 41]])])
    expect(await f.run('viewer_analyze_surfaces', args)).toMatchObject({ status: 'invalid_region_map', unresolvedIds: ['overshoots'] })
    await saveMap([region('panel', [[0, 40]])])
    expect(await f.run('viewer_analyze_surfaces', args)).toMatchObject({
      status: 'analyzed', coverage: { triangles: 40, uncoveredTriangles: 0, uncoveredAreaMm2: 0 }, parts: [], total: 0,
    })
  } finally {
    await f.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
