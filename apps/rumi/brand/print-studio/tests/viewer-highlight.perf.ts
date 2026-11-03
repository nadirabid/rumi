/** CPU diagnostic for repeated region changes on a large static mesh; excludes transport and GPU drawing. */
import * as THREE from 'three'
import { createHighlight } from '../viewer/viewport/highlight.js'
import { analyzeMesh } from '../viewer/checks.js'
import { placeMesh } from '../viewer/transform.js'

const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 400, 220), new THREE.MeshStandardMaterial())
const geometry = mesh.geometry.toNonIndexed()
const positions = geometry.getAttribute('position').array
const transform = { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } }
let overlay = createHighlight(mesh, { blobs: [] })
const rebuild = process.argv.includes('--rebuild')
const samples: number[] = []
for (let i = 0; i < 15; i++) {
  const highlight = { blobs: [{ center: [i, 0, 30], radii: [20, 30, 40], rotationDegrees: [0, 0, 0] }] }
  const start = performance.now()
  if (rebuild) {
    overlay.dispose()
    overlay = createHighlight(mesh, highlight)
    analyzeMesh(placeMesh(positions, transform).positions)
  } else overlay.update(highlight)
  if (i >= 3) samples.push(performance.now() - start)
}
const sorted = [...samples].sort((a, b) => a - b)
console.log(JSON.stringify({ rebuild, triangles: positions.length / 9, samplesMs: samples, medianMs: sorted[6], maxMs: sorted.at(-1) }))
overlay.dispose()
mesh.geometry.dispose()
mesh.material.dispose()
geometry.dispose()
