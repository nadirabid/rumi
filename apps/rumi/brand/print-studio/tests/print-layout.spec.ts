/** Print transforms preserve assembly geometry and reject unsafe or stale placement. */
import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { printParts, arrangePrintParts, createPrintPreview, layoutIssues } from '../viewer/viewport/print-layout.js'
import { parsePrintLayout, printLayoutIdentity } from '../viewer/print-layout/state.js'
import { readPrintLayout, savePrintLayout, registerPrintLayout } from '../viewer/print-layout/host.js'
import { parseStl } from '../viewer/stl.js'

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

it('arranges separate parts on additional plates without changing source placement or geometry', () => {
  const design = model(), parts = printParts(design)
  const before = design.root.children.map(node => node.matrixWorld.toArray())
  const layout = arrangePrintParts(parts, { ...options, volume: { x: 50, y: 50, z: 50 } })
  expect(layout.parts.map(part => part.plate)).toEqual([0, 1])
  expect(layoutIssues(parts, layout)).toEqual([])
  const scene = new THREE.Scene(), preview = createPrintPreview(parts, scene)
  preview.apply(layout, 0)
  expect(preview.root.children[0].children[0].geometry).toBe(parts[0].meshes[0].node.geometry)
  const dispose = vi.spyOn(parts[0].meshes[0].node.geometry, 'dispose')
  const positions = parseStl(preview.exportPlate())
  const z = Array.from(positions).filter((_, i) => i % 3 === 2)
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

it('exports mirrored source transforms with outward winding and the chosen plate only', () => {
  const design = model(); design.root.children[0].scale.x = -1
  const parts = printParts(design), layout = arrangePrintParts(parts, { ...options, volume: { x: 50, y: 50, z: 50 } })
  const preview = createPrintPreview(parts, new THREE.Scene())
  for (const placement of layout.parts) {
    preview.apply(layout, placement.plate)
    const p = parseStl(preview.exportPlate())
    expect(p.length).toBe(108)
    let signedVolume = 0
    for (let i = 0; i < p.length; i += 9) {
      const a = new THREE.Vector3(...p.slice(i, i + 3)), b = new THREE.Vector3(...p.slice(i + 3, i + 6))
      signedVolume += a.dot(b.cross(new THREE.Vector3(...p.slice(i + 6, i + 9)))) / 6
    }
    expect(signedVolume).toBeGreaterThan(0)
  }
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
