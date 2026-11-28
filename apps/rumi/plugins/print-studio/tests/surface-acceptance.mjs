/** Real USD surface preview acceptance probe. Run with an input JSON containing source, and an output directory; add --verify-published after publishing the CAD revision. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { createSurfacePreview, surfaceContext } from '../viewer/analog/surface.js'
import { controlReviewCases } from '../viewer/analog/review-cases.js'
import { measureControlCase } from '../viewer/analog/evidence.js'
import { normalizeShape } from '../viewer/analog/spec.js'

const maximum = values => values.reduce((a, b) => Math.max(a, b), -Infinity)
const [inputPath, output] = process.argv.slice(2)
if (!inputPath || !output) throw new Error('Pass input JSON and output directory')
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
await fs.mkdir(output, { recursive: true })
const bytes = await fs.readFile(input.source)
const model = await parseUsdModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
const capture = () => {
  model.root.updateWorldMatrix(true, true)
  const result = {}
  model.root.traverseVisible(node => {
    if (!node.isMesh) return
    const point = new THREE.Vector3(), positions = node.geometry.getAttribute('position')
    result[node.name] = Array.from({ length: positions.count }, (_, i) => point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld).toArray())
  })
  return result
}
try {
  const before = capture()
  assert(before.Shell && before.Faceplate, 'The helmet acceptance case needs Shell and Faceplate')
  const context = surfaceContext(before.Shell.map(point => ({ point })))
  const mid = (context.zMin + context.zMax) / 2
  const plateEnd = maximum(before.Faceplate.map(p => .5 + Math.atan2(p[1] - context.center[1], p[2] - mid) / (2 * Math.PI)))
  const fixedEnd = plateEnd + .025
  assert(fixedEnd < .45, 'Plate reaches the crown; this case needs an explicit interface reconstruction')
  const xMax = maximum(before.Shell.map(p => p[0]))
  const definitions = {
    profile: { form: { kind: 'profile', at: [0, fixedEnd, .42, .6, .7, .82, 1], pinned: [0, 1, 5, 6], links: { 3: 2 }, directions: [[0, -1], [1, 0], [0, 1], [0, 1], [-1, 0], [-1, 0], [0, -1]] }, values: { p2: 12, p4: 8 } },
    facet: { form: { kind: 'facet', from: .3, to: .85, wallThickness: 3.5, planes: [{ normal: [1, 0, 0], offset: xMax - 8 }, { normal: [-1, 0, 0], offset: xMax - 8 }] }, values: { amount: 1 } },
  }
  const reports = {}
  for (const [name, definition] of Object.entries(definitions)) {
    const controls = Object.keys(definition.values).map(key => ({ kind: 'slider', label: key, axes: [{ key, min: name === 'facet' ? 0 : -8, max: name === 'facet' ? 1 : 12, step: .1, reset: 0 }] }))
    const recipe = { ...normalizeShape({ operation: 'surface', label: name, parts: ['Shell'], ...definition, controls }),
      frozen: true, source: input.source, sourceHash: createHash('sha256').update(bytes).digest('hex') }
    const cases = controlReviewCases(recipe).cases
    for (const test of cases) measureControlCase(model.root, recipe, test)
    const preview = createSurfacePreview(model.root, recipe)
    const after = capture()
    preview.dispose()
    assert.deepEqual(after.Faceplate, before.Faceplate, 'The faceplate moved')
    const protectedIndices = before.Shell.flatMap((p, i) => {
      const t = .5 + Math.atan2(p[1] - context.center[1], p[2] - mid) / (2 * Math.PI)
      return t >= .1 && t <= plateEnd && Math.abs(p[0]) < 60 ? [i] : []
    })
    const protectedTravel = maximum(protectedIndices.map(i => Math.hypot(...after.Shell[i].map((v, j) => v - before.Shell[i][j]))))
    assert(protectedTravel < .0001, 'The shell adjacent to the seated plate moved')
    const topBefore = maximum(before.Shell.map(p => p[2])), topAfter = maximum(after.Shell.map(p => p[2]))
    const plane = xMax - 8
    const core = before.Shell.flatMap((p, i) => Math.abs(p[0]) > plane && p[2] > context.zMin + .4 * (context.zMax - context.zMin)
      && p[2] < context.zMin + .75 * (context.zMax - context.zMin) ? [i] : [])
    const planeError = maximum(core.map(i => Math.min(Math.abs(Math.abs(after.Shell[i][0]) - plane), Math.abs(Math.abs(after.Shell[i][0]) - (plane - 3.5)))))
    if (name === 'profile') assert(topAfter - topBefore > 10, `Crown rise ${topAfter-topBefore} mm does not match requested travel`)
    else { assert(core.length > 100, 'No useful planar patch'); assert(planeError < .0001, 'Facet core is not planar') }
    const expected = Object.fromEntries(Object.keys(before).map(part => {
      const unique = new Map()
      before[part].forEach((p, i) => unique.set(p.join(','), { before: p, after: after[part][i] }))
      return [part, [...unique.values()]]
    }))
    await fs.writeFile(path.join(output, `${name}.json`), JSON.stringify({ ...input, recipe, expected }))
    reports[name] = { validatedEndpointsAndCombinations: cases.length, crownRiseMm: topAfter - topBefore, protectedTravelMm: protectedTravel, pinnedPlateVertices: before.Faceplate.length,
      ...(name === 'facet' ? { planarVertices: core.length, planeErrorMm: planeError } : {}) }
  }
  await fs.writeFile(path.join(output, 'preview-report.json'), JSON.stringify(reports, null, 2))
  console.log(JSON.stringify(reports))
  if (process.argv.includes('--verify-published')) {
    const baked = JSON.parse(await fs.readFile(path.join(output, 'bake-report.json'), 'utf8')), result = {}
    for (const name of Object.keys(definitions)) {
      const { expected } = JSON.parse(await fs.readFile(path.join(output, `${name}.json`), 'utf8'))
      const indexes = {}
      for (const [part, points] of Object.entries(expected)) {
        const cells = new Map()
        for (const { after } of points) {
          const key = after.map(n => Math.round(n * 100)).join(',')
          if (!cells.has(key)) cells.set(key, [])
          cells.get(key).push(after)
        }
        indexes[part] = cells
      }
      const bytes = await fs.readFile(baked[name].published.preview)
      const saved = await parseUsdModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      let maximumError = 0, vertices = 0
      try {
        saved.root.updateWorldMatrix(true, true)
        saved.root.traverseVisible(node => {
          if (!node.isMesh) return
          const cells = indexes[node.name], positions = node.geometry.getAttribute('position'), point = new THREE.Vector3()
          assert(cells, 'Published an unexpected part')
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld)
            const p = point.toArray(), cell = p.map(n => Math.round(n * 100))
            let distance = Infinity
            for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
              for (const candidate of cells.get([cell[0] + x, cell[1] + y, cell[2] + z].join(',')) ?? []) {
                distance = Math.min(distance, Math.hypot(...p.map((n, j) => n - candidate[j])))
              }
            }
            assert(distance < .01, `${name}: published USD differs from preview by ${distance} mm`)
            maximumError = Math.max(maximumError, distance); vertices++
          }
        })
      } finally { disposeModel(saved.root) }
      result[name] = { vertices, maxPublishedUsdErrorMm: maximumError }
    }
    await fs.writeFile(path.join(output, 'published-report.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  }
} finally { disposeModel(model.root) }
