/** A session's scene is edited by commands; geometry is read once and never rewritten by placement. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyViewer } from '../viewer/host.js'
import { parseStl } from '../viewer/stl.js'
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
    printer: await readFile(new URL('../skills/printer-awareness/SKILL.md', import.meta.url), 'utf8'),
    setup: await readFile(new URL('../skills/print-studio-setup/SKILL.md', import.meta.url), 'utf8'),
    fdm: await readFile(new URL('../skills/fdm-design/SKILL.md', import.meta.url), 'utf8'),
    blender: await readFile(new URL('../skills/blender-modeling/SKILL.md', import.meta.url), 'utf8'),
    instructions: await readFile(new URL('../AGENTS_TEMPLATE.md', import.meta.url), 'utf8'),
    load: f.raw('viewer_load').description,
    cursor: f.raw('viewer_cursor_snapshot').description,
    highlight: f.raw('viewer_highlight').description,
    clarification: await readFile(new URL('../skills/clarify-mesh-changes/SKILL.md', import.meta.url), 'utf8'),
    stateToolAvailable: Boolean(f.raw('mesh_state')),
    working: f.raw('viewer_working_model').description,
    analog: f.raw('viewer_controls').description,
    interactive: await readFile(new URL('../skills/interactive-controls/SKILL.md', import.meta.url), 'utf8'),
    shaping: await readFile(new URL('../skills/analog-shaping/SKILL.md', import.meta.url), 'utf8'),
  }).toMatchSnapshot()
})

it('exposes Blender preview fields on the controls tool', () => {
  const tool = fixture().raw('viewer_controls')
  expect(tool.parameters.properties).toMatchObject({ finish: { enum: ['parameters', 'blender'] }, original: { type: 'string' }, edit: { type: 'string' } })
})

function fixture(source: Uint8Array = stl(box()), cwd = '/workspace') {
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
    fs: { resolve: async (path: string) => ({ path, displayPath: path }), readBytes: async () => source },
  }
  const diagnosticsDirectory = mkdtempSync(join(tmpdir(), 'rumi-viewer-diagnostics-'))
  diagnosticRoots.push(diagnosticsDirectory)
  applyViewer(ctx, defineTool, diagnosticsDirectory)
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
  expect(report).toMatchObject({ objectCount: 1, status: 'ok', volume: null })
  expect(report.objects[0]).toMatchObject({ name: 'box.stl', dimensions: { x: 12, y: 12, z: 2 } })

  const state = await f.state()
  expect(state.revision).toBe(1) // one addObject command
  expect(state.summary).toEqual({ status: 'ok', errors: 0, warnings: 0 })
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
    const reference = { path: loaded.design.path, revision: loaded.design.revision, url: loaded.design.url,
      label: 'Upper region', blobs: [{ center: [0, 0, 3], radii: [2, 2, 1], rotationDegrees: [0, 0, 0] }] }
    const highlighting = f.run('viewer_highlight', reference)
    let scene
    await expect.poll(async () => { scene = await f.state(); return scene.design.highlight?.id }).toBeTruthy()
    const design = scene.design
    await f.routes.get('/api/print-studio/viewer/feedback')!(new Request('http://rumi/api/print-studio/viewer/feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ revision: design.revision, url: design.url, transform: design.transform, highlightId: design.highlight.id }),
    }))
    const highlighted = await highlighting
    expect({ status: highlighted.status, reason: highlighted.reason, message: highlighted.message }).toMatchSnapshot('acknowledged highlight result')
    expect(highlighted.status).toBe('rendered')
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
    expect((await f.run('viewer_highlight', { ...reference, revision: 99 })).status).toBe('stale_model')
    expect((await f.run('viewer_highlight', { ...reference, blobs: [], label: '' })).status).toBe('cleared')
    const placed = await f.run('viewer_transform', { scale: 2, rotate: { z: 90 } })
    expect(placed.design.transform).toMatchObject({ scale: 2, rotate: { z: 90 } })
    const camera = await f.run('viewer_camera', { azimuth: 45, elevation: 30 })
    expect(camera.camera).toMatchObject({ azimuth: 45, elevation: 30 })
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
    region: { objectId: response.scene.objects[0].id, partPath: ['box'], faceIndex: 0, worldPoint: [0, 0, 1], worldRadius: 2, modelLocalBlob: null },
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
  expect(await f.run('viewer_cursor_snapshot', {}, 'other-session')).toEqual({ status: 'viewer_unavailable' })
})

it('unloads while a cursor request is waiting without retaining a tool or timer', async () => {
  const f = fixture()
  await f.run('mesh_open', { path: 'box.stl' })
  const pending = f.run('viewer_cursor_snapshot')
  await expect.poll(async () => (await (await f.request('/api/print-studio/viewer/state?sessionId=session-a')).json()).cursorRequest?.id).toBeTruthy()
  await f.dispose()
  expect(await pending).toEqual({ status: 'viewer_unavailable' })
  expect(f.routes.size).toBe(0)
})

it('refines a spoken selection through the original cursor anchor and retains the resulting reference', async () => {
  const f = fixture()
  type Block = { type: 'text'; text: string } | { type: 'image'; attachment: object }
  type Contributor = {
    captureRequest(request: { sessionId: string; requestedAt: string; signal: AbortSignal }): Promise<Block[]>
    refineRequest(request: { sessionId: string; text: string; content: Block[]; signal: AbortSignal }): Promise<Block[]>
  }
  let registered: Contributor | undefined
  f.owner.provide('liveVoice', { register(value: Contributor) { registered = value; return () => {} } })
  await f.run('mesh_open', { path: 'box.stl' })
  if (!registered) throw new Error('Pointing contributor did not register')
  const contributor = registered
  const signal = new AbortController().signal
  const base = '/api/print-studio/viewer'
  async function reply(mode: string, anchorId: string, expected?: object) {
    let pending: { cursorRequest: { id: string }; scene: { revision: number; objects: { id: string }[] } } | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await (await f.request(`${base}/state?sessionId=session-a`)).json()
      if (state.cursorRequest) { pending = state; break }
    }
    if (!pending) throw new Error('Viewer did not receive the cursor request')
    if (expected) expect(pending.cursorRequest).toMatchObject(expected)
    const snapshot = { status: 'captured', capturedAt: new Date().toISOString(),
      identity: { sceneRevision: pending.scene.revision, design: null },
      region: { objectId: pending.scene.objects[0].id, partPath: ['box'], faceIndex: 0,
        worldPoint: [1, 2, 3], worldRadius: 4, modelLocalBlob: null,
        selection: { partPath: ['box'], surfaceId: 1, mode }, anchorId },
      camera: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 40, aspect: 1 },
      image: 'data:image/png;base64,cG5n' }
    const result = await f.routes.get(`${base}/cursor`)!(new Request(`http://rumi${base}/cursor?sessionId=session-a`, {
      method: 'POST', body: JSON.stringify({ requestId: pending.cursorRequest.id, snapshot }),
    }))
    expect(result.status).toBe(200)
  }
  const capture = contributor.captureRequest({ sessionId: 'session-a', requestedAt: new Date().toISOString(), signal })
  await reply('patch', 'original')
  const content = await capture
  const refinement = contributor.refineRequest({ sessionId: 'session-a', text: 'whole panel', content, signal })
  await reply('surface', 'refined', { command: 'surface', anchorId: 'original' })
  const refined = await refinement
  if (refined[0].type !== 'text') throw new Error('Missing refined reference')
  expect(JSON.parse(refined[0].text).snapshot.region.selection.mode).toBe('surface')
  expect(refined.filter(part => part.type === 'image')).toHaveLength(1)
  expect(await contributor.refineRequest({ sessionId: 'session-a', text: 'whole panel', content: refined, signal })).toBe(refined)
})

it('opens analog controls and freezes a fresh viewer capture without rewriting the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-analog-host-')), f = fixture(undefined, root)
  try {
    const text = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] })
    const content = Buffer.from(text + ' '.repeat((4 - text.length % 4) % 4)), bytes = Buffer.alloc(20 + content.length)
    ;[0x46546c67, 2, bytes.length, content.length, 0x4e4f534a].forEach((n, i) => bytes.writeUInt32LE(n, i * 4)); content.copy(bytes, 20)
    await vi.waitFor(() => expect(f.contexts.has('rumi:active-shape')).toBe(true))
    const editContext = f.contexts.get('rumi:active-shape')
    const path = join(root, 'model.glb'); await writeFile(path, bytes)
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const values = { amount: .65, spread: .5, peakX: .5, peakY: .5, falloff: .5, angle: .5 }
    const opened = f.run('viewer_controls', { action: 'open', path: 'model.glb', url: design.url, revision: design.revision, operation: 'bulge', label: 'Back', center: [0, 0, 0], radii: [30, 30, 30], direction: [0, 1, 0], limit: 10, parts: [], values, controls: legacyControls('bulge') })
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
    expect(editContext?.text({ agent: { session: { id: 'session-a' } } })).toBe('')
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
  const root = await mkdtemp(join(tmpdir(), 'rumi-control-feedback-')), f = fixture(undefined, root)
  try {
    const path = join(root, 'model.mjs')
    await writeFile(path, 'export const parameters={size:60};export function build(){}\n')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const pending = f.run('viewer_controls', { action: 'open', path, revision: design.revision, url: design.url,
      operation: 'parameters', label: 'Size', values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    })
    let id: string
    await vi.waitFor(async () => { id = (await f.state()).design.analog?.id; expect(id).toBeTruthy() })
    const feedback = (body: object) => f.routes.get('/api/print-studio/viewer/shape-feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/shape-feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ id, url: design.url, ...body }),
      },
    ))
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

it('rejects freezing a Blender preview when its preserved original changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-original-')), f = fixture(undefined, root)
  try {
    const path = join(root, 'model.js'), original = join(root, 'original.glb')
    await writeFile(path, 'export const parameters={size:60};export function build(){}\n')
    await writeFile(original, 'original')
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const pending = f.run('viewer_controls', { action: 'open', path, revision: design.revision, url: design.url,
      operation: 'parameters', label: 'Size', finish: 'blender', original, edit: 'Set the box width to size millimetres.', values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    })
    let id: string
    await vi.waitFor(async () => { id = (await f.state()).design.analog?.id; expect(id).toBeTruthy() })
    const feedback = (body: object) => f.routes.get('/api/print-studio/viewer/shape-feedback')!(new Request(
      'http://rumi/api/print-studio/viewer/shape-feedback?sessionId=session-a', {
        method: 'POST', body: JSON.stringify({ id, url: design.url, ...body }),
      },
    ))
    await feedback({ status: 'rendered' }); expect(await pending).toMatchObject({ status: 'rendered' })
    await writeFile(original, 'changed')
    const freezing = f.run('viewer_controls', { action: 'freeze', id })
    await vi.waitFor(async () => expect((await f.state()).design.analog.freezeRequested).toBe(true))
    await feedback({ status: 'frozen', sequence: 1, values: { size: 90 } })
    await expect(freezing).rejects.toThrow('Preserved original changed')
    expect(await readFile(original, 'utf8')).toBe('changed')
    expect((await f.state()).design.analog).toMatchObject({ frozen: true, values: { size: 90 } })
  } finally { await f.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, 'parameters'])('uses preview metadata when finish is %s', async (finish) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-marker-')), f = fixture(undefined, root)
  try {
    const path = join(root, 'model.js'), original = join(root, 'original.blend')
    await writeFile(path, 'export const parameters={size:60};export function build(){}\n')
    await writeFile(original, 'original')
    await writeFile(join(root, '.rumi-preview.json'), JSON.stringify({ original: 'original.blend', edit: 'Set width to size; preserve height.' }))
    await f.run('viewer_load', { path })
    const design = (await f.state()).design
    const pending = f.run('viewer_controls', { action: 'open', path, revision: design.revision, url: design.url,
      operation: 'parameters', label: 'Size', ...(finish ? { finish } : {}), values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    })
    let analog: any
    await vi.waitFor(async () => { analog = (await f.state()).design.analog; expect(analog?.id).toBeTruthy() })
    await f.routes.get('/api/print-studio/viewer/shape-feedback')!(new Request('http://rumi/api/print-studio/viewer/shape-feedback?sessionId=session-a', {
      method: 'POST', body: JSON.stringify({ id: analog.id, url: design.url, status: 'rendered' }),
    }))
    expect(await pending).toMatchObject({ status: 'rendered', controls: { finish: 'blender', original: await realpath(original), edit: 'Set width to size; preserve height.' } })
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
