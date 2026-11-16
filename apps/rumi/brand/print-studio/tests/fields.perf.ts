/** Synthetic helmet-sized field setup and drag cost, including normal updates. */
import * as THREE from 'three'
import { createFieldPreview } from '../viewer/analog/field-preview.js'
import { normalizeShape } from '../viewer/analog/spec.js'

const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 420, 210))
mesh.name = 'Shell'
root.add(mesh)
const keys = ['a', 'b', 'c', 'd'], offsets = Array(81).fill(0)
offsets[41] = 20
const spec = normalizeShape({
  operation: 'fields', label: 'Profile', parts: ['Shell'], values: Object.fromEntries(keys.map(k => [k, 0])),
  controls: keys.map(key => ({ kind: 'slider', label: key, axes: [{ key, min: -1, max: 1, step: .01, reset: 0 }] })),
  fields: keys.map(key => ({ key, origin: [-150, -150, -150], spacing: [150, 150, 150], dimensions: [3, 3, 3], offsets })),
})
const before = process.memoryUsage(), start = performance.now(), preview = createFieldPreview(root, spec)
const setup = performance.now() - start, frames = []
for (let i = 0; i < 30; i++) {
  const start = performance.now()
  preview.update(Object.fromEntries(keys.map(k => [k, Math.sin(i)])))
  frames.push(performance.now() - start)
}
console.log(JSON.stringify({
  vertices: mesh.geometry.attributes.position.count, setupMs: setup,
  meanUpdateMs: frames.reduce((a, b) => a + b) / frames.length,
  maxUpdateMs: Math.max(...frames), before, after: process.memoryUsage(),
}))
preview.dispose()
mesh.geometry.dispose()
