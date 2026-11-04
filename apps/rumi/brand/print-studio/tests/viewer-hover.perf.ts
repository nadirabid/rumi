/** CPU picking and retained-memory diagnostic; GPU frame time must be measured in the viewer. */
import * as THREE from 'three'
import { createHighlight } from '../viewer/viewport/highlight.js'

const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 450, 220), new THREE.MeshStandardMaterial())
mesh.updateMatrixWorld(true)
const hover = process.argv.includes('--hover')
const accelerated = process.argv.includes('--accelerated')
const prepareStart = performance.now()
const overlay = hover || accelerated ? createHighlight(mesh, { blobs: [] }, { value: new THREE.Vector4() }) : null
const prepareMs = performance.now() - prepareStart
const ray = new THREE.Raycaster()
const samples: number[] = []
for (let i = 0; i < 140; i++) {
  ray.set(new THREE.Vector3(Math.sin(i) * 50, 0, 300), new THREE.Vector3(0, 0, -1))
  const start = performance.now()
  if (accelerated) mesh.geometry.userData.rumiSurfaceIndex.pick(ray.ray, mesh.material)
  else ray.intersectObject(mesh, false)
  if (i >= 20) samples.push(performance.now() - start)
}
samples.sort((a, b) => a - b)
global.gc?.()
console.log(JSON.stringify({
  hover, accelerated, prepareMs, triangles: 197100, samples: samples.length,
  medianMs: samples[60], p95Ms: samples[114],
  memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
}))
overlay?.dispose()
mesh.geometry.dispose()
mesh.material.dispose()
