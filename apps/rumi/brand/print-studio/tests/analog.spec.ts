/** Analog edits preserve source geometry and capture the latest viewer values. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as workflow from '../viewer/analog/workflow.js'
import { expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../viewer/source.js'
import { normalizeShape, INITIAL_VALUES, deformPoint, cutPlane } from '../viewer/analog/spec.js'
import { createHighlight } from '../viewer/viewport/highlight.js'
import { createShapeDeformer } from '../viewer/analog/gpu.js'

const recipe = { operation: 'bulge', label: 'Back', center: [0, 0, 0], radii: [50, 60, 40], direction: [0, 1, 0], limit: 20, parts: [], values: INITIAL_VALUES }

it('keeps neutral and outside vertices fixed and moves the centre by the requested millimetres', () => {
  for (const operation of ['bulge', 'bend', 'twist', 'taper']) {
    const spec = normalizeShape({ ...recipe, operation })
    expect(deformPoint([100, 100, 100], spec)).toEqual([100, 100, 100])
    expect(deformPoint([10, 5, 3], { ...spec, values: { ...spec.values, amount: .5 } })).toEqual([10, 5, 3])
  }
  expect(deformPoint([0, 0, 0], normalizeShape(recipe))[1]).toBeCloseTo(6)
  expect(() => normalizeShape({ ...recipe, values: { ...INITIAL_VALUES, amount: Infinity } })).toThrow('amount')
  expect(() => normalizeShape({ ...recipe, radii: [0, 10, 10] })).toThrow('radii')
  expect(() => normalizeShape({ ...recipe, operation: 'extrude' })).toThrow('Unsupported')
})

it('updates uniforms without rewriting buffers and restores shared materials on disposal', () => {
  const root = new THREE.Group(), geometry = new THREE.SphereGeometry(1, 40, 20), material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  root.add(mesh); root.scale.setScalar(1000); root.rotation.x = Math.PI / 2
  const positions = geometry.attributes.position.array.slice(), version = geometry.attributes.position.version
  const dispose = vi.spyOn(material, 'dispose')
  const compile = vi.spyOn(material, 'onBeforeCompile')
  const control = createShapeDeformer(root, normalizeShape(recipe))
  const compiled = { uniforms: {}, vertexShader: '#include <beginnormal_vertex>\n#include <begin_vertex>' } as Parameters<typeof material.onBeforeCompile>[0]
  mesh.material.onBeforeCompile(compiled, {} as THREE.WebGLRenderer)
  expect(compile).toHaveBeenCalledOnce()
  const owned = mesh.material, release = vi.spyOn(owned, 'dispose')
  for (let i = 0; i < 1000; i++) control.update({ ...INITIAL_VALUES, amount: i / 1000 })
  expect(compiled.uniforms.shapeAmount.value).toBe(.999)
  expect(compiled.uniforms.shapeToModel.value.elements[0]).toBe(1000)
  expect(geometry.attributes.position.array).toEqual(positions)
  expect(geometry.attributes.position.version).toBe(version)
  control.dispose()
  expect(mesh.material).toBe(material)
  expect(mesh.frustumCulled).toBe(true)
  expect(release).toHaveBeenCalledOnce()
  expect(dispose).not.toHaveBeenCalled()
  geometry.dispose(); material.dispose()
})

it('rejects stale feedback and freezes a live capture newer than the last released value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-analog-')), owner = new Context()
  try {
    const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] })
    const content = Buffer.from(json + ' '.repeat((4 - json.length % 4) % 4)), bytes = Buffer.alloc(20 + content.length)
    ;[0x46546c67, 2, bytes.length, content.length, 0x4e4f534a].forEach((n, i) => bytes.writeUInt32LE(n, i * 4)); content.copy(bytes, 20)
    const path = join(root, 'model.glb'); await writeFile(path, bytes)
    const source = await createSource({ effect: owner.effect.bind(owner), connection: { fetch: { register: () => () => {} } } }, path, root)
    const state = source.state(), spec = source.shape({ ...recipe, ...state, ...recipe })
    const feedback = { id: spec.id, url: state.url, status: 'adjusted', sequence: 2, values: { ...INITIAL_VALUES, amount: .7 } }
    expect(source.shapeFeedback(feedback)).toBe(true)
    expect(source.shapeFeedback({ ...feedback, sequence: 1, values: INITIAL_VALUES })).toBe(false)
    expect(() => source.shapeFeedback({ ...feedback, status: 'frozen', sequence: 3 })).toThrow('not requested')
    expect(source.state().analog.editRevision).toBe(2)
    const highlight = { ...state, label: 'Back', blobs: [{ center: [0, 0, 0], radii: [20, 20, 20], rotationDegrees: [0, 0, 0] }] }
    source.highlight(highlight)
    expect(source.state().highlight).not.toBeNull()
    source.requestShapeFreeze(spec.id)
    expect(source.shapeFeedback({ ...feedback, status: 'frozen', sequence: 4, values: { ...INITIAL_VALUES, amount: .9 } })).toBe(true)
    expect(source.freezeShape(spec.id)).toMatchObject({
      frozen: true, values: { amount: .9 }, source: state.path, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(source.state().highlight).toBeNull()
    expect(source.shapeFeedback({ ...feedback, sequence: 5 })).toBe(false)
    source.highlight(highlight)
    source.clearShape(spec.id)
    expect(source.state()).toMatchObject({ analog: null, highlight: null })
    expect(source.shapeFeedback(feedback)).toBe(false)
    source.highlight(highlight)
    const cut = source.shape({ ...recipe, ...state, ...recipe, operation: 'cut' })
    expect(source.state().highlight).toBeNull()
    expect(source.highlight(highlight)).toMatchObject({ status: 'active_cut' })
    expect(source.state().highlight).toBeNull()
    source.clearShape(cut.id)
    expect(source.highlight(highlight)).toMatchObject({ status: 'queued' })
  } finally { await owner.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('publishes the analog workflow in model instructions and removes it on unload', async () => {
  const owner = new Context()
  try {
    await owner.plugin(SystemPrompt)
    const fork = owner.plugin(workflow)
    await fork
    expect(renderPrompt(await owner.systemPrompt.assemble())).toMatchSnapshot()
    await fork.dispose()
    expect(renderPrompt(await owner.systemPrompt.assemble())).not.toContain('viewer_controls')
  } finally { await owner.fiber.dispose() }
})

it('composes deformation with the region highlight and restores resources in ownership order', () => {
  const root = new THREE.Group(), geometry = new THREE.BoxGeometry(20, 20, 20), material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geometry, material); root.add(mesh)
  const overlay = createHighlight(root, { blobs: [{ center: [0, 0, 0], radii: [20, 20, 20], rotationDegrees: [0, 0, 0] }] })
  const highlighted = mesh.material, displayGeometry = mesh.geometry
  const control = createShapeDeformer(root, normalizeShape(recipe))
  const compiled = { uniforms: {}, vertexShader: '#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' } as Parameters<typeof material.onBeforeCompile>[0]
  mesh.material.onBeforeCompile(compiled, {} as THREE.WebGLRenderer)
  expect(compiled.vertexShader).toContain('rumiPoint = rumiLocalPoint')
  expect(compiled.vertexShader).toContain('transformed=shapeObject(position)')
  expect(compiled.fragmentShader).toContain('rumiRegionCount')
  expect(mesh.geometry).toBe(displayGeometry)
  expect(compiled.uniforms.rumiRegionCount.value).toBe(1)
  overlay.update({ blobs: [] })
  expect(compiled.uniforms.rumiRegionCount.value).toBe(0)
  control.dispose()
  expect(mesh.material).toBe(highlighted)
  overlay.dispose()
  expect(mesh.material).toBe(material)
  expect(mesh.geometry).toBe(geometry)
  material.dispose(); geometry.dispose()
})

it('keeps a continuous cut plane independent of the Gaussian region and matches height and tilt', () => {
  const spec = normalizeShape({ ...recipe, operation: 'cut', direction: [0, 0, 1], center: [0, 0, 40], values: { ...INITIAL_VALUES, amount: .75, angle: .625, spread: .5 } })
  const plane = cutPlane(spec)
  const distance = (p: number[]) => p.reduce((sum, value, i) => sum + value * plane.normal[i], plane.constant)
  expect(plane.point).toEqual([0, 0, 50])
  expect(distance([300, 100, 50 + 100 * Math.tan(Math.PI / 12)])).toBeCloseTo(0)
  expect(distance([0, 0, 70])).toBeGreaterThan(0)
  expect(distance([0, 0, 30])).toBeLessThan(0)
})

it('clips selected parts, updates cap placement without changing buffers, and restores highlighted materials', () => {
  const parent = new THREE.Group(), root = new THREE.Group()
  parent.add(root); root.scale.setScalar(1000)
  const geometry = new THREE.BoxGeometry(.1, .1, .1), material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'Shell'; root.add(mesh)
  const untouched = new THREE.Mesh(geometry, material); untouched.name = 'Other'; root.add(untouched)
  const overlay = createHighlight(root, { blobs: [{ center: [0, 0, 0], radii: [50, 50, 50], rotationDegrees: [0, 0, 0] }] })
  const highlighted = mesh.material, otherMaterial = untouched.material, positions = mesh.geometry.attributes.position.array.slice()
  const control = createShapeDeformer(root, normalizeShape({ ...recipe, operation: 'cut', direction: [0, 0, 1], parts: ['Shell'] }))
  const compiled = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <clipping_planes_fragment>\n#include <opaque_fragment>' } as Parameters<typeof material.onBeforeCompile>[0]
  mesh.material.onBeforeCompile(compiled, {} as THREE.WebGLRenderer)
  expect(compiled.fragmentShader).toContain('discard;')
  expect(compiled.fragmentShader).toContain('cutLine')
  expect(compiled.uniforms.rumiCutGuide.value).toBe(1)
  control.setGuideVisible(false)
  expect(compiled.uniforms.rumiCutGuide.value).toBe(0)
  control.setGuideVisible(true)
  expect(compiled.uniforms.rumiRegionCount.value).toBe(1)
  expect(compiled.uniforms.rumiCutToModel.value.elements[0]).toBe(1000)
  const display = parent.children.find(child => child !== root)!
  expect(display.children).toHaveLength(3)
  for (let i = 0; i < 1000; i++) control.update({ ...INITIAL_VALUES, amount: i / 1000, angle: .5, spread: .5 })
  expect(compiled.uniforms.rumiCutPlane.value.w).toBeCloseTo(-19.96)
  expect(display.children[2].position.z).toBeCloseTo(19.96)
  expect(mesh.geometry.attributes.position.array).toEqual(positions)
  expect(untouched.material).toBe(otherMaterial)
  overlay.update({ blobs: [] })
  expect(compiled.uniforms.rumiRegionCount.value).toBe(0)
  control.dispose()
  expect(parent.children).toEqual([root])
  expect(mesh.material).toBe(highlighted)
  overlay.dispose(); geometry.dispose(); material.dispose()
})
