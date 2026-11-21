/** Print transforms preserve assembly geometry and reject unsafe or stale placement. */
import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { strFromU8, unzipSync } from 'three/addons/libs/fflate.module.js'
import { printParts, arrangePrintParts, createPrintPreview, layoutIssues } from '../viewer/viewport/print-layout.js'
import { parsePrintLayout, printLayoutIdentity } from '../viewer/print-layout/state.js'
import { readPrintLayout, savePrintLayout, registerPrintLayout } from '../viewer/print-layout/host.js'
import { makePrint3mf } from '../viewer/print-layout/three-mf.js'
import { PRINT_FACE_BYTES } from '../viewer/print-layout/plate-payload.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function model(mode = 'separate') {
  const root = new THREE.Group()
  const left = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 10), new THREE.MeshStandardMaterial())
  left.name = 'base'; left.position.set(5, 6, 7)
  const right = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 40), left.material)
  right.name = 'door'; right.position.set(50, 0, 10)
  root.add(left, right)
  return { root, robot: { assembly: { parts: [{ id: 'base', mesh: 'base' }, { id: 'door', mesh: 'door' }],
    connections: [{ kind: 'revolute', parent: 'base', child: 'door' }], manufacturing: { mode } } } }
}
const options = { identity: 'revision-one', volume: { x: 60, y: 60, z: 60 }, gap: 5 }

async function exportModel(payload: FormData, volume = options.volume) {
  const request = new Request('http://localhost/open-plate', { method: 'POST', body: payload })
  const form = await request.formData()
  const files = unzipSync(await makePrint3mf(form, volume))
  return new JSDOM(strFromU8(files['3D/3dmodel.model']), { contentType: 'text/xml' }).window.document
}

function vertices(object: Element) {
  return [...object.querySelectorAll('vertex')].map(vertex => new THREE.Vector3(
    Number(vertex.getAttribute('x')), Number(vertex.getAttribute('y')), Number(vertex.getAttribute('z')),
  ))
}

it('arranges separate parts on additional plates without changing source placement or geometry', async () => {
  const design = model(), parts = printParts(design)
  const before = design.root.children.map(node => node.matrixWorld.toArray())
  const layout = arrangePrintParts(parts, { ...options, volume: { x: 50, y: 50, z: 50 } })
  expect(layout.parts.map(part => part.plate)).toEqual([0, 1])
  expect(layoutIssues(parts, layout)).toEqual([])
  const scene = new THREE.Scene(), preview = createPrintPreview(parts, scene)
  preview.apply(layout, 0)
  expect(preview.root.children[0].children[0].geometry).toBe(parts[0].meshes[0].node.geometry)
  const dispose = vi.spyOn(parts[0].meshes[0].node.geometry, 'dispose')
  const exported = await exportModel(preview.exportPlate(), layout.volume)
  const z = vertices(exported.querySelector('object')!).map(point => point.z)
  expect(Math.min(...z)).toBeCloseTo(0)
  expect(Math.max(...z)).toBeCloseTo(10)
  preview.dispose()
  expect(dispose).not.toHaveBeenCalled()
  expect(design.root.children.map(node => node.matrixWorld.toArray())).toEqual(before)
})

it('blocks legacy printed-assembled movement without changing its source and keeps static groups intact', () => {
  const legacy = model('print-in-place')
  expect(() => printParts(legacy)).toThrow('layoutSeparateRequired')
  expect(legacy.robot.assembly.manufacturing.mode).toBe('print-in-place')
  legacy.robot.assembly.connections[0].kind = 'fixed'
  expect(printParts(legacy)).toHaveLength(1)
  const design = model(); design.robot.assembly.connections[0].kind = 'fixed'
  expect(printParts(design)).toHaveLength(2)
  expect(() => printParts({ root: model().root })).toThrow('Declare')
})

it('blocks overlapping and out-of-bounds exports without shrinking parts', () => {
  const parts = printParts(model()), layout = arrangePrintParts(parts, options)
  for (const part of layout.parts) { part.plate = 0; part.position = [0, 0] }
  expect(layoutIssues(parts, layout)).toContain('layoutOverlap')
  const preview = createPrintPreview(parts, new THREE.Scene())
  preview.apply(layout, 0)
  expect(() => preview.exportPlate()).toThrow('Resolve')
  layout.parts[0].position = [1000, 0]
  expect(layoutIssues(parts, layout)).toContain('layoutOutside')
  expect(layoutIssues(parts, arrangePrintParts(parts, { ...options, volume: { x: 5, y: 5, z: 5 } }))).toContain('layoutOutside')
})

it('exports mirrored source transforms with outward winding and the chosen plate only', async () => {
  const design = model(); design.root.children[0].scale.x = -1
  const parts = printParts(design), layout = arrangePrintParts(parts, { ...options, volume: { x: 50, y: 50, z: 50 } })
  const preview = createPrintPreview(parts, new THREE.Scene())
  for (const placement of layout.parts) {
    preview.apply(layout, placement.plate)
    const exported = await exportModel(preview.exportPlate(), layout.volume)
    const objects = exported.querySelectorAll('object')
    expect(objects).toHaveLength(1)
    expect(objects[0].getAttribute('name')).toBe(placement.id)
    const points = vertices(objects[0])
    const faces = objects[0].querySelectorAll('triangle')
    expect(faces).toHaveLength(12)
    let signedVolume = 0
    for (const face of faces) {
      const [a, b, c] = ['v1', 'v2', 'v3'].map(key => points[Number(face.getAttribute(key))])
      signedVolume += a.dot(b.clone().cross(c)) / 6
    }
    expect(signedVolume).toBeGreaterThan(0)
  }
})

it('exports two independently placeable objects and preserves material assignments within one connected mesh', async () => {
  const design = model()
  const [base, door] = design.root.children as THREE.Mesh<THREE.BoxGeometry>[]
  base.name = 'Base & "hinge"'
  const red = new THREE.MeshStandardMaterial({ color: '#D44335' })
  base.material = [red, new THREE.MeshStandardMaterial({ color: '#2984C0' }), red, red, red, red]
  door.geometry = door.geometry.toNonIndexed()
  door.material = new THREE.MeshStandardMaterial({ color: '#3DA050' })
  const parts = printParts(design), volume = { x: 120, y: 120, z: 120 }
  const layout = arrangePrintParts(parts, { ...options, volume })
  const preview = createPrintPreview(parts, new THREE.Scene())
  preview.apply(layout, 0)
  const exported = await exportModel(preview.exportPlate(), volume)
  const objects = [...exported.querySelectorAll('object')]
  const items = [...exported.querySelectorAll('build item')]
  expect(items.map(item => item.getAttribute('objectid'))).toEqual(objects.map(object => object.id))
  const colors = [...exported.getElementsByTagName('m:color')].map(entry => entry.getAttribute('color'))
  for (const object of objects) {
    const name = object.getAttribute('name')
    const placement = layout.parts.find(part => part.id === name)!
    const bounds = new THREE.Box3().setFromPoints(vertices(object))
    expect(bounds.getCenter(new THREE.Vector3()).toArray().slice(0, 2))
      .toEqual(placement.position.map(coordinate => coordinate + 60))
    expect(bounds.min.z).toBeCloseTo(0)
    expect(vertices(object)).toHaveLength(8)
    const faceColors = [...object.querySelectorAll('triangle')].map(face => colors[Number(face.getAttribute('p1'))])
    expect(faceColors).toEqual(name === base.name
      ? ['#D44335', '#D44335', '#2984C0', '#2984C0', ...Array(8).fill('#D44335')]
      : Array(12).fill('#3DA050'))
  }
  expect(objects.map(object => object.getAttribute('name')).sort()).toEqual([base.name, door.name].sort())
})

it('rejects malformed durable transforms, duplicate parts and unsafe plate indices', () => {
  const layout = arrangePrintParts(printParts(model()), options)
  expect(parsePrintLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
  for (const change of [{ plate: -1 }, { plate: 128 }, { rotation: [45, 0, 0] }, { position: [Infinity, 0] }]) {
    expect(() => parsePrintLayout({ ...layout, parts: [{ ...layout.parts[0], ...change }] })).toThrow()
  }
  expect(() => parsePrintLayout({ ...layout, parts: [layout.parts[0], layout.parts[0]] })).toThrow()
})

it('saves by model and detects source, scale and volume changes across restarts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rumi-print-layout-')); roots.push(cwd)
  const design = { path: 'models/robot/model.usda', contentHash: 'a', transform: { scale: 1 } }
  const identity = printLayoutIdentity(design, options.volume)
  const layout = arrangePrintParts(printParts(model()), { ...options, identity })
  expect(await readPrintLayout(cwd, design.path)).toBeNull()
  await savePrintLayout(cwd, design.path, layout)
  expect(await readPrintLayout(cwd, design.path)).toEqual(layout)
  expect(await readPrintLayout(cwd, 'models/other/model.usda')).toBeNull()
  expect(printLayoutIdentity({ ...design, contentHash: 'b' }, options.volume)).not.toBe(identity)
  expect(printLayoutIdentity({ ...design, transform: { scale: 2 } }, options.volume)).not.toBe(identity)
  expect(printLayoutIdentity(design, { ...options.volume, x: 100 })).not.toBe(identity)
  const path = join(cwd, `.rumi-print-layout-${createHash('sha256').update(design.path).digest('hex')}.json`)
  await writeFile(path, '{broken')
  await expect(readPrintLayout(cwd, design.path)).rejects.toThrow()
  await rm(path); await writeFile(join(cwd, 'outside'), '{}'); await symlink(join(cwd, 'outside'), path)
  await expect(readPrintLayout(cwd, design.path)).rejects.toThrow()
  await savePrintLayout(cwd, design.path, layout)
  expect(await readFile(join(cwd, 'outside'), 'utf8')).toBe('{}')
})

it('rejects stale and malformed HTTP saves and restores only the matching source revision', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rumi-print-routes-')); roots.push(cwd)
  const design = { path: 'models/robot/model.usda', contentHash: 'a', transform: { scale: 1 } }
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const register = (entry: { path: string; fetch: (request: Request) => Promise<Response> }) => {
    routes.set(entry.path, entry.fetch)
    return () => {}
  }
  let requiresSeparatePrint = false
  registerPrintLayout({ effect: callback => callback(), connection: { fetch: { register } } },
    async (_id, operation) => operation({ design, cwd, requiresSeparatePrint, model: design.path, volume: options.volume }), options)
  const route = routes.get('/api/print-studio/viewer/layout')!
  const layout = arrangePrintParts(printParts(model()), { ...options, identity: printLayoutIdentity(design, options.volume) })
  const post = (hash: string, body: string) => route(new Request(`http://localhost/layout?sessionId=s&sourceHash=${hash}`, { method: 'POST', body }))
  expect((await post('old', JSON.stringify(layout))).status).toBe(409)
  expect((await post('a', '{}')).status).toBe(400)
  expect((await post('a', JSON.stringify(layout))).status).toBe(200)
  expect(await (await route(new Request('http://localhost/layout?sessionId=s'))).json()).toMatchObject({ layout, stale: false })
  const open = routes.get('/api/print-studio/viewer/open-plate')!
  const openPlate = (body: FormData) => open(new Request('http://localhost/open-plate?sessionId=s&sourceHash=a', { method: 'POST', body }))
  const payload = new FormData()
  payload.append('name', 'Part')
  expect((await openPlate(payload)).status).toBe(400)
  const face = new DataView(new ArrayBuffer(PRINT_FACE_BYTES))
  face.setFloat32(0, 1000, true)
  payload.append('mesh', new Blob([face]))
  const request = new Request('http://localhost/open-plate?sessionId=s&sourceHash=a', { method: 'POST', body: payload })
  const contentType = request.headers.get('content-type')!
  const boundary = contentType.split('boundary=')[1]
  // Chromium emits mixed-case boundaries, which Blob.type lowercases.
  const browserBoundary = '----WebKitFormBoundaryRumiTest'
  const body = Buffer.from(await request.arrayBuffer()).toString('latin1').replaceAll(boundary, browserBoundary)
  const browserRequest = new Request(request.url, {
    method: 'POST', headers: { 'content-type': contentType.replace(boundary, browserBoundary) }, body: Buffer.from(body, 'latin1'),
  })
  expect(await (await open(browserRequest)).json()).toEqual({ error: 'layoutOutside' })
  requiresSeparatePrint = true
  for (const path of ['layout', 'open-plate']) {
    const response = await routes.get(`/api/print-studio/viewer/${path}`)!(
      new Request(`http://localhost/${path}?sessionId=s`, { method: 'POST', body: '{}' }))
    expect(await response.json()).toEqual({ error: 'layoutSeparateRequired' })
    expect(response.status).toBe(409)
  }
  requiresSeparatePrint = false
  design.contentHash = 'b'
  expect(await (await route(new Request('http://localhost/layout?sessionId=s'))).json()).toMatchObject({ layout: null, stale: true })
})
