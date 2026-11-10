/** GLB import preserves physical coordinates and never loads external resources. */
import { robotUsd } from './fixtures/robot-usd.js'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateGlb } from '../viewer/glb.js'
import { parseGlbModel } from '../viewer/viewport/glb.js'
import { createHighlight } from '../viewer/viewport/highlight.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { analyzeMesh } from '../viewer/checks.js'
import { createSource } from '../viewer/source.js'
import { discoverModels } from '../viewer/catalog.js'
import { applyBlender, blenderStatus } from '../blender/host.js'

function glb(extra = {}) {
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.3, -0.2])
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'faceplate', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, -0.2], max: [0.1, 0.3, 0] }], ...extra })
  const text = new TextEncoder().encode(json + ' '.repeat((4 - json.length % 4) % 4))
  const bytes = new Uint8Array(28 + text.length + positions.byteLength)
  const view = new DataView(bytes.buffer)
  ;[0x46546c67, 2, bytes.length, text.length, 0x4e4f534a].forEach((v, i) => view.setUint32(i * 4, v, true))
  bytes.set(text, 20)
  view.setUint32(20 + text.length, positions.byteLength, true)
  view.setUint32(24 + text.length, 0x004e4942, true)
  bytes.set(new Uint8Array(positions.buffer), 28 + text.length)
  return bytes
}

it('converts standard GLB metres/Y-up to millimetres/Z-up and retains part names', async () => {
  const model = await parseGlbModel(glb().buffer)
  try {
    expect(model.root.getObjectByName('faceplate')).toBeDefined()
    const report = analyzeMesh(model.positions)
    expect(report.dimensions.x).toBeCloseTo(100, 3)
    expect(report.dimensions.y).toBeCloseTo(200, 3)
    expect(report.dimensions.z).toBeCloseTo(300, 3)
    const overlay = createHighlight(model.root, { blobs: [{ center: [0, 200, 300], radii: [10, 10, 10], rotationDegrees: [0, 0, 0] }] })
    const part = model.root.getObjectByName('faceplate')
    const points = part.geometry.getAttribute('rumiLocalPoint')
    expect(points.getY(2)).toBeCloseTo(200, 3)
    expect(points.getZ(2)).toBeCloseTo(300, 3)
    overlay.dispose()
  } finally { disposeModel(model.root) }
})

it('rejects external resources, animation and truncated containers before parsing', async () => {
  expect(() => validateGlb(glb({ images: [{ uri: 'https://example.com/image.png' }] }))).toThrow('Embed')
  expect(() => validateGlb(glb({ buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }] }))).toThrow('Embed')
  expect(() => validateGlb(glb({ animations: [{}] }))).toThrow('static')
  expect(() => validateGlb(glb().subarray(0, 24))).toThrow('container')
})

it('publishes immutable USD layers, retains the previous version on a partial save and discovers USD first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-glb-'))
  const owner = new Context()
  const routes = new Map<string, () => Promise<Response>>()
  try {
    const directory = join(root, 'models', 'helmet')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'model.usda')
    await writeFile(path, robotUsd())
    await writeFile(join(directory, 'model.js'), 'legacy')
    const ctx = { effect: owner.effect.bind(owner),
      connection: { fetch: { register(route: { path: string; fetch: () => Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      } } } }
    const source = await createSource(ctx, path, root)
    const before = source.state()
    expect(before.format).toBe('usd')
    expect(await discoverModels(root)).toEqual([{ name: 'helmet', path: 'models/helmet/model.usda' }])
    expect((await routes.get(before.url)!()).headers.get('content-type')).toBe('model/vnd.usda; charset=utf-8')
    await writeFile(path, 'partial export')
    await source.poll()
    expect(source.state()).toMatchObject({ url: before.url, error: { kind: 'source' } })
    await writeFile(path, new Uint8Array([...robotUsd(), ...new TextEncoder().encode('\n# revision 2\n')]))
    await source.poll(); await source.poll()
    expect(source.state().url).not.toBe(before.url)
    expect(source.state().error).toBeNull()
    expect(new Uint8Array(await (await routes.get(before.url)!()).arrayBuffer())).toEqual(robotUsd())
    await source.dispose()
    expect(routes.size).toBe(0)
  } finally { await owner.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('does not silently fall back from an invalid explicit Blender executable', async () => {
  expect(await blenderStatus('/missing/Blender', '/missing')).toMatchObject({ status: 'invalid_executable' })
  const status = await blenderStatus(process.execPath, '/unused')
  expect(status.status).toBe('ready')
  expect(await readFile(status.helper, 'utf8')).toContain('def publish(')
})

it('writes the project check settings only when Blender is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-blender-status-'))
  try {
    const validation = { minimumThicknessMm: 1, minimumClearanceMm: 0.2 }
    const tools: Array<{ name: string, execute(args: object, exec: object): Promise<string> }> = []
    const ctx = { effect: (run: () => unknown) => run(), tools: { register: (tool: typeof tools[number]) => tools.push(tool) },
      workingDirectory: { ensure: async () => root } }
    const status = (blenderExecutable: string) => {
      tools.length = 0
      applyBlender(ctx, (tool: object) => tool, { blenderExecutable, blenderHome: '/unused', validation })
      return tools[0]!.execute({}, { agent: {}, signal: new AbortController().signal }).then(JSON.parse)
    }
    expect(await status('/missing/Blender')).toMatchObject({ status: 'invalid_executable' })
    await expect(readFile(join(root, '.rumi/print-checks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const ready = await status(process.execPath)
    expect(ready).toMatchObject({ status: 'ready', checks: join(root, '.rumi/print-checks.json') })
    expect(ready.execution).toContain('RUMI_CHECKS')
    expect(JSON.parse(await readFile(ready.checks, 'utf8'))).toEqual({ version: 1, settings: validation })
    expect(await readdir(join(root, '.rumi'))).toEqual(['print-checks.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
