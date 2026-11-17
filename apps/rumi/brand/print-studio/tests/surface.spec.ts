/** Surface deformation follows the part's own ring and meridian coordinates. */
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { normalizeShape } from '../viewer/analog/spec.js'
import { createSurfacePreview, surfaceContext, surfaceDelta } from '../viewer/analog/surface.js'

/** Evenly sampled cylinder shell used as a stand-in for a helmet surface. */
function cylinder() {
  const points = []
  for (let row = 0; row <= 10; row++) {
    const z = row * 20
    for (let step = 0; step < 36; step++) {
      const angle = step * 10
      points.push([Math.cos(angle * Math.PI / 180) * 100, Math.sin(angle * Math.PI / 180) * 100, z])
    }
  }
  return points
}

const points = cylinder()
const samples = points.map(point => ({ part: 0, point }))
const control = (key: string, min: number, max: number) => ({ kind: 'slider', label: key, axes: [{ key, min, max, step: 1, reset: 0 }] })

it('derives the same frame from unique vertices and expanded triangles', () => {
  const context = surfaceContext(samples, -90)
  expect(context).toEqual(surfaceContext([...samples, ...samples.slice(0, 30), ...samples.slice(0, 30)], -90))
  expect(context.zMin).toBe(0)
  expect(context.zMax).toBe(200)
})

it('raises the crown continuously and follows a rotated front direction', () => {
  const context = surfaceContext(samples, -90)
  const form = { kind: 'profile', lateral: 1, at: [.1, .5, .9] }
  const values = { p0: 0, p1: 10, p2: 0 }
  expect(surfaceDelta([0, 0, 200], context, form, values)[2]).toBeCloseTo(10, 6)
  const left = surfaceDelta([0, -.001, 200], context, form, values)
  const right = surfaceDelta([0, .001, 200], context, form, values)
  expect(Math.hypot(...left.map((v, i) => v - right[i]))).toBeLessThan(.001)
  expect(left[2]).toBeCloseTo(10, 6)
  const front = surfaceDelta([0, -100, 100], context, form, values)
  const rotated = surfaceDelta([100, 0, 100], { ...context, uAt: 0 }, form, values)
  expect(rotated[0]).toBeCloseTo(-front[1], 6)
  expect(rotated[2]).toBeCloseTo(front[2], 6)
})

it('cuts a groove along the meridian with the declared width', () => {
  const context = surfaceContext(samples, -90)
  const form = { kind: 'channel', lateral: 1, at: [0], from: 0, to: 1, widthMillimetres: 60, edge: .08 }
  const midline = surfaceDelta([0, -100, 100], context, form, { depth: 5 })
  const flank = surfaceDelta([-Math.sin(Math.PI / 6) * 100, -Math.cos(Math.PI / 6) * 100, 100], context, form, { depth: 5 })
  expect(midline[1]).toBeCloseTo(5, 6)
  expect(Math.max(...flank.map(Math.abs))).toBeLessThan(0.001)
})

it('makes two genuinely planar side patches without collapsing the inner shell', () => {
  const context = surfaceContext(samples)
  const form = { kind: 'facet', from: 0, to: 1, edge: .08,
    planes: [{ normal: [1, 0, 0], offset: 98 }, { normal: [-1, 0, 0], offset: 98 }] }
  for (const side of [-1, 1]) for (const z of [40, 80, 120, 160]) for (const angle of [-10, -5, 0, 5, 10]) {
    const p = [side * 100 * Math.cos(angle * Math.PI / 180), 100 * Math.sin(angle * Math.PI / 180), z]
    const delta = surfaceDelta(p, context, form, { amount: 1 })
    expect(p[0] + delta[0]).toBeCloseTo(side * 98, 6)
    expect(delta[1]).toBe(0)
    const inside = [side * 96 * Math.cos(angle * Math.PI / 180), 96 * Math.sin(angle * Math.PI / 180), z]
    expect(surfaceDelta(inside, context, form, { amount: 1 })).toEqual([0, 0, 0])
    expect(Math.abs(p[0] + delta[0] - inside[0])).toBeGreaterThanOrEqual(2)
  }
})

it('previews without touching the saved geometry until disposed', () => {
  const geometry = new THREE.CylinderGeometry(100, 100, 200, 36, 10, true)
  const node = new THREE.Mesh(geometry)
  node.name = 'Shell'
  const root = new THREE.Group()
  root.add(node)
  const original = geometry.getAttribute('position').array.slice()
  const spec = normalizeShape({ operation: 'surface', label: 'Profile', parts: ['Shell'], form: { kind: 'profile', at: [0, 1] },
    values: { p0: 0, p1: 0 }, controls: [control('p0', -20, 20), control('p1', -20, 20)] })
  const preview = createSurfacePreview(root, spec)
  preview.update({ p0: 0, p1: 0 })
  expect(Array.from(node.geometry.getAttribute('position').array)).toEqual(Array.from(original))
  preview.update({ p0: 0, p1: 10 })
  expect(Math.max(...Array.from(node.geometry.getAttribute('position').array).map((value, index) => Math.abs(value - original[index])))).toBeGreaterThan(5)
  preview.dispose()
  expect(node.geometry).toBe(geometry)
})

it.each(['profile', 'facet', 'ring', 'channel'])('matches Python with expanded preview vertices and unique bake vertices for %s', (kind) => {
  const recipe = normalizeShape({ operation: 'surface', label: 'Profile', parts: ['Shell'],
    uAt: -90,
    ...(kind === 'profile' ? { form: { kind, at: [.2, .6, .9] }, values: { p0: 6, p1: -3, p2: 11 },
      controls: [control('p0', -20, 20), control('p1', -20, 20), control('p2', -20, 20)] }
      : kind === 'facet' ? { form: { kind, from: 0, to: 1, planes: [{ normal: [0, -1, 0], offset: 90 }] }, values: { amount: 1 }, controls: [control('amount', 0, 1)] }
        : kind === 'ring' ? { form: { kind, from: 0, to: 1, millimetres: 10 }, values: { amount: .7 }, controls: [control('amount', -1, 1)] }
          : { form: { kind, from: 0, to: 1, widthMillimetres: 40, at: [0] }, values: { depth: 5 }, controls: [control('depth', -10, 10)] }) })
  const context = surfaceContext([...samples, ...samples.slice(0, 40)], recipe.uAt)
  const probes = [[0, -100, 20], [30, -95, 120], [-70, -70, 180], [100, 0, 90], [0, 100, 40]]
  const code = `import runpy,json,sys
m = runpy.run_path('apps/rumi/brand/print-studio/blender/surface.py')
data = json.load(sys.stdin)
m['validate_surface'](data['recipe'])
context = m['surface_context']([tuple(p) for p in data['points']], data['recipe'].get('uAt', -90))
print(json.dumps([[p, m['surface_point'](list(p), data['recipe'], context)] for p in data['probes']]))`
  const actual = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code],
    { input: JSON.stringify({ recipe, points, probes }), encoding: 'utf8' }))
  for (const [index, [point, moved]] of actual.entries()) {
    const delta = surfaceDelta(point, context, recipe.form, recipe.values)
    for (const axis of [0, 1, 2]) expect(moved[axis]).toBeCloseTo(probes[index][axis] + delta[axis], 6)
  }
})

it('rejects unbound axes and malformed bands', () => {
  const base = { operation: 'surface', label: 'Profile', parts: ['Shell'], form: { kind: 'profile', at: [0, 1] }, values: { p0: 0, p1: 0 }, controls: [control('p0', -20, 20), control('p1', -20, 20)] }
  expect(() => normalizeShape({ ...base, values: { p0: 0 } , controls: [control('p0', -20, 20)] })).toThrow('binds exactly')
  expect(() => normalizeShape({ ...base, form: { kind: 'profile', at: [1, 0] } })).toThrow('rise')
  expect(() => normalizeShape({ ...base, form: { kind: 'ring', from: .8, to: .2, millimetres: 5 }, values: { amount: 0 }, controls: [control('amount', -1, 1)] })).toThrow('from below to')
  expect(() => normalizeShape({ ...base, parts: [] })).toThrow('mesh names')
  expect(() => normalizeShape({ ...base, form: { kind: 'channel', at: [0], from: 0, to: 1, widthMillimetres: 0 }, values: { depth: 0 }, controls: [control('depth', -10, 10)] })).toThrow('widthMillimetres')
})

it('measures real displacement for every review case across several parts', async () => {
  const { measureControlCase } = await import('../viewer/analog/evidence.js')
  const { controlReviewCases } = await import('../viewer/analog/review-cases.js')
  const make = (name: string, radius: number, height: number) => {
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 24, 12, true)
    geometry.translate(0, height / 2, 0)
    const node = new THREE.Mesh(geometry)
    node.name = name
    return node
  }
  const root = new THREE.Group()
  root.add(make('Shell', 100, 200))
  root.add(make('Faceplate', 40, 60))
  root.updateWorldMatrix(true, true)
  const spec = normalizeShape({ operation: 'surface', label: 'Profile', parts: ['Shell'], uAt: -90,
    form: { kind: 'profile', lateral: 1, at: [.15, .4, .7, .92] }, values: { p0: 0, p1: 0, p2: 0, p3: 0 },
    controls: [0, 1, 2, 3].map(index => control(`p${index}`, -8, 8)) })
  const { cases } = controlReviewCases(spec)
  expect(cases.length).toBe(10)
  for (const test of cases) {
    const result = measureControlCase(root, spec, test)
    expect(Number.isFinite(result.metrics.maxDisplacementMm)).toBe(true)
  }
  const moved = measureControlCase(root, spec, cases.find(test => test.id === 'p1:max')!)
  expect(moved.metrics.maxDisplacementMm).toBeGreaterThan(1)
})

it('renders evidence through the surface adapter instead of the fixed-operation deformer', async () => {
  const { createSpecPreview } = await import('../viewer/analog/evidence-renderer.js')
  const geometry = new THREE.CylinderGeometry(100, 100, 200, 24, 12, true)
  const node = new THREE.Mesh(geometry)
  node.name = 'Shell'
  const root = new THREE.Group()
  root.add(node)
  root.updateWorldMatrix(true, true)
  const spec = normalizeShape({ operation: 'surface', label: 'Profile', parts: ['Shell'],
    form: { kind: 'profile', at: [0, 1] }, values: { p0: 0, p1: 0 }, controls: [control('p0', -8, 8), control('p1', -8, 8)] })
  const preview = createSpecPreview(root, spec)
  expect(preview.update({ p0: 0, p1: 6 })).toBe(true)
  preview.dispose()
})

it('keeps the two faces of a shell on separate facet planes', () => {
  const context = surfaceContext(samples)
  const form = { kind: 'facet', from: 0, to: 1, edge: .08, wallThickness: 4,
    planes: [{ normal: [1, 0, 0], offset: 85 }] }
  for (const y of [-10, 0, 10]) {
    const outer = [Math.sqrt(100 ** 2 - y ** 2), y, 100]
    const inner = [Math.sqrt(96 ** 2 - y ** 2), y, 100]
    const outerDelta = surfaceDelta(outer, context, form, { amount: 1 }, [1, 0, 0])
    const innerDelta = surfaceDelta(inner, context, form, { amount: 1 }, [-1, 0, 0])
    expect(outer[0] + outerDelta[0]).toBeCloseTo(85, 6)
    expect(inner[0] + innerDelta[0]).toBeCloseTo(81, 6)
  }
  expect(() => surfaceDelta([100, 0, 100], context, form, { amount: 1 }, [0, 0, 1])).toThrow('ambiguous shell edge')
})

it('rejects collapsed surface triangles through the actual evidence path', async () => {
  const { measureControlCase } = await import('../viewer/analog/evidence.js')
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([10, 0, 30, 20, 0, 30, 15, 0, 70], 3))
  const mesh = new THREE.Mesh(geometry)
  mesh.name = 'Shell'
  const root = new THREE.Group()
  root.add(mesh)
  const spec = normalizeShape({ operation: 'surface', label: 'Flat side', parts: ['Shell'],
    form: { kind: 'facet', from: 0, to: 1, planes: [{ normal: [1, 0, 0], offset: 0 }] }, values: { amount: 0 }, controls: [control('amount', 0, 1)] })
  // Add height bounds without changing the selected triangle's interior band.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([10, 0, 30, 20, 0, 30, 15, 0, 70, 0, 0, 0, 0, 1, 0, 0, 0, 100], 3))
  expect(() => measureControlCase(root, spec, { baseline: { amount: 0 }, values: { amount: 1 } })).toThrow('collapse or invert')
  geometry.dispose()
})

it('exposes only adjustable stations and keeps pinned profile spans fixed', () => {
  const spec = normalizeShape({ operation: 'surface', label: 'Outline', parts: ['Shell'],
    form: { kind: 'profile', at: [0, .35, .5, .7, .85, 1], pinned: [0, 1, 4, 5] },
    values: { p2: 12, p3: 8 }, controls: [control('p2', -8, 12), control('p3', -8, 12)] })
  const context = surfaceContext(samples)
  expect(spec.controls).toHaveLength(2)
  expect(Math.hypot(...surfaceDelta([0, -100, 100], context, spec.form, spec.values))).toBe(0)
  expect(surfaceDelta([0, 0, 200], context, spec.form, spec.values)[2]).toBe(12)
  expect(() => normalizeShape({ ...spec, values: { ...spec.values, p0: 2 } })).toThrow('binds exactly')
  expect(() => normalizeShape({ ...spec, controls: [control('p2', -8, 12)] })).toThrow('Every surface parameter')
})

it('preserves the saved mesh when shell facet construction fails', () => {
  const geometry = new THREE.PlaneGeometry(20, 20)
  geometry.translate(100, 0, 100)
  const mesh = new THREE.Mesh(geometry)
  mesh.name = 'Shell'
  const root = new THREE.Group()
  root.add(mesh)
  const spec = normalizeShape({ operation: 'surface', label: 'Flat side', parts: ['Shell'],
    form: { kind: 'facet', from: 0, to: 1, wallThickness: 4, planes: [{ normal: [1, 0, 0], offset: 85 }] },
    values: { amount: 0 }, controls: [control('amount', 0, 1)] })
  // A vertical span puts the tangentially oriented face inside the requested band.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([100, 0, 0, 110, 0, 100, 100, 10, 200, 100, 10, 100], 3))
  expect(() => createSurfacePreview(root, spec)).toThrow('ambiguous shell edge')
  expect(mesh.geometry).toBe(geometry)
  geometry.dispose()
})

it('translates a linked profile section without deforming its internal geometry', () => {
  const spec = normalizeShape({ operation: 'surface', label: 'Outline', parts: ['Shell'],
    form: { kind: 'profile', at: [0, .4, .6, 1], pinned: [0, 3], links: { 2: 1 }, directions: [[0, -1], [0, 1], [0, 1], [0, -1]] },
    values: { p1: 12 }, controls: [control('p1', -8, 12)] })
  const context = surfaceContext(samples)
  for (const point of [[0, 0, 200], [10, -10, 195], [-10, 20, 198]]) {
    const delta = surfaceDelta(point, context, spec.form, spec.values)
    expect(Math.hypot(delta[0], delta[1])).toBe(0)
    expect(delta[2]).toBe(12)
  }
  expect(() => normalizeShape({ ...spec, form: { ...spec.form, links: { 1: 2 } } })).toThrow('earlier unpinned')
})
