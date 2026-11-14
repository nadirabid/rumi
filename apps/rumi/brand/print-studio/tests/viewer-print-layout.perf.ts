/** CPU layout preparation, placement and STL export; excludes loading, React and GPU drawing. */
import * as THREE from 'three'
import { printParts, arrangePrintParts, createPrintPreview } from '../viewer/viewport/print-layout.js'

const fixture = process.argv.includes('--assembly') ? 'assembly' : process.argv.includes('--small') ? 'small' : 'large'
const geometry = fixture === 'large' ? new THREE.SphereGeometry(100, 450, 220) : new THREE.SphereGeometry(fixture === 'assembly' ? 10 : 100, 32, 16)
const material = new THREE.MeshStandardMaterial(), root = new THREE.Group(), scene = new THREE.Scene()
const partCount = fixture === 'assembly' ? 8 : 1
for (let i = 0; i < partCount; i++) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `part-${i}`; mesh.position.set(i * 25, 0, 0); root.add(mesh)
}
const design = { root, robot: { assembly: {
  parts: root.children.map(mesh => ({ id: mesh.name, mesh: mesh.name })), connections: [], manufacturing: { mode: 'separate' },
} } }
const triangles = geometry.index!.count / 3 * partCount
const options = { identity: 'diagnostic-source', volume: { x: 300, y: 320, z: 320 }, gap: 5 }
global.gc?.()
const before = process.memoryUsage()
const start = performance.now()
const parts = printParts(design)
const collectedAt = performance.now()
const layout = arrangePrintParts(parts, options)
const arrangedAt = performance.now()
const preview = createPrintPreview(parts, scene, new THREE.Color('white'))
preview.apply(layout, 0, layout.parts[0].id)
const preparedAt = performance.now()
global.gc?.()
const preparedMemory = process.memoryUsage()
const placementSamplesMs: number[] = [], exportSamplesMs: number[] = []
let exported: ArrayBuffer | null = null
try {
  const first = layout.parts[0], originalX = first.position[0]
  for (let iteration = 0; iteration < 140; iteration++) {
    first.position[0] = originalX + Math.sin(iteration) * .1
    const updatedAt = performance.now()
    preview.apply(layout, 0, first.id)
    if (iteration >= 20) placementSamplesMs.push(performance.now() - updatedAt)
  }
  first.position[0] = originalX
  preview.apply(layout, 0, first.id)
  for (let iteration = 0; iteration < 3; iteration++) {
    const exportAt = performance.now()
    exported = preview.exportPlate()
    exportSamplesMs.push(performance.now() - exportAt)
  }
  if (!exported || new DataView(exported).getUint32(80, true) !== triangles) throw new Error('Diagnostic export lost source triangles')
  global.gc?.()
  const sorted = [...placementSamplesMs].sort((a, b) => a - b)
  console.log(JSON.stringify({ fixture, triangles, partCount,
    prepareMs: preparedAt - start, collectMs: collectedAt - start, arrangeMs: arrangedAt - collectedAt, previewMs: preparedAt - arrangedAt,
    placementSamplesMs, placementMedianMs: sorted[60], placementP95Ms: sorted[114], exportSamplesMs, exportBytes: exported.byteLength,
    before, preparedMemory, memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
  }))
} finally { preview.dispose(); geometry.dispose(); material.dispose() }
