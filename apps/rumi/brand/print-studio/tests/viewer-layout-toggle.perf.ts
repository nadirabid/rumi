/** CPU-only assembly/layout resource toggles; excludes GPU upload, drawing and React updates. */
import * as THREE from 'three'
import { createHighlight } from '../viewer/viewport/highlight.js'

const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 450, 220), new THREE.MeshStandardMaterial())
mesh.updateMatrixWorld(true)
let overlay = createHighlight(mesh, { blobs: [] })
const rebuild = process.argv.includes('--rebuild')
global.gc?.()
const before = process.memoryUsage()
const samplesMs: number[] = []
for (let iteration = 0; iteration < 4; iteration++) {
  const start = performance.now()
  if (rebuild) { overlay.dispose(); overlay = createHighlight(mesh, { blobs: [] }) }
  else { overlay.suspend(); overlay.resume() }
  if (iteration > 0) samplesMs.push(performance.now() - start)
}
global.gc?.()
console.log(JSON.stringify({ rebuild, triangles: 197100, samplesMs, before,
  memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS }))
overlay.dispose(); mesh.geometry.dispose(); mesh.material.dispose()
