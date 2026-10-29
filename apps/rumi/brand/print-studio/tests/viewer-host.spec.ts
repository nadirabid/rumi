/** A session's scene is edited by commands; geometry is read once and never rewritten by placement. */
import { expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyViewer } from '../viewer/host.js'
import { parseStl } from '../viewer/stl.js'

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

function fixture(source: Uint8Array = stl(box())) {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const tools = new Map<string, any>() // The fixture captures dynamically registered JavaScript tool definitions.
  const cleanup: (() => void)[] = []
  const ctx = {
    effect: (effect: () => (() => void)) => cleanup.push(effect()),
    connection: { fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      routes.set(route.path, route.fetch)
      return () => { routes.delete(route.path) }
    } } },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => {} } },
    workingDirectory: { ensure: async () => '/workspace' },
    fs: { resolve: async (path: string) => ({ path, displayPath: path }), readBytes: async () => source },
  }
  applyViewer(ctx, defineTool)
  const signal = () => new AbortController().signal
  const run = async (name: string, args: object = {}, sessionId = 'session-a') => JSON.parse(
    await tools.get(name).execute(args, { agent: { session: { id: sessionId } }, signal: signal() }),
  )
  return {
    routes, cleanup, run,
    raw: (name: string) => tools.get(name),
    request: (path: string) => routes.get(path.split('?')[0])!(new Request(`http://rumi${path}`)),
    state: async (sessionId = 'session-a') => (await (await routes.get('/api/print-studio/viewer/state')!(
      new Request(`http://rumi/api/print-studio/viewer/state?sessionId=${sessionId}`),
    )).json()).scene,
    dispose: () => { for (const dispose of cleanup.toReversed()) dispose() },
  }
}

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
  expect((await f.run('mesh_state')).objectCount).toBe(0)
  await f.run('mesh_open', { path: 'box.stl' })
  const report = await f.run('mesh_state')
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
  f.dispose()
  expect(f.routes.size).toBe(0)
  await expect(f.run('mesh_open', { path: 'box.stl' })).rejects.toThrow('closed')
})
