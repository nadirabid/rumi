/** Measure the viewer's connected surfaces off the host thread and return transferable triangle data. */
import { parentPort, workerData } from 'node:worker_threads'
import { Box3, Triangle, Vector3 } from 'three'
import { modelPartPath } from './viewport/cursor-geometry.js'
import { createSurfaceIndex } from './viewport/surfaces.js'
import { parseUsdModel } from './viewport/usd.js'

function measurePart(node, vertices) {
  const index = createSurfaceIndex(node.geometry)
  const rows = new Map()
  for (let face = 0; face < index.count; face++) {
    const id = index.surface(face)
    if (!rows.has(id)) rows.set(id, rows.size)
  }
  const surfaceIds = Uint32Array.from(rows.keys())
  const triangles = new Uint32Array(rows.size)
  const areas = new Float64Array(rows.size)
  const centers = new Float64Array(rows.size * 3), normals = new Float64Array(rows.size * 3)
  const minimums = new Float64Array(rows.size * 3).fill(Infinity)
  const maximums = new Float64Array(rows.size * 3).fill(-Infinity)
  const triangle = new Triangle(), corners = [triangle.a, triangle.b, triangle.c]
  const vector = new Vector3(), bounds = new Box3()
  for (let face = 0; face < index.count; face++) {
    const row = rows.get(index.surface(face)), offset = row * 3
    triangles[row]++
    for (const [i, point] of corners.entries()) {
      point.fromArray(vertices, face * 9 + i * 3)
      bounds.expandByPoint(point)
      for (let axis = 0; axis < 3; axis++) {
        const value = point.getComponent(axis)
        minimums[offset + axis] = Math.min(minimums[offset + axis], value)
        maximums[offset + axis] = Math.max(maximums[offset + axis], value)
      }
    }
    const area = triangle.getArea()
    areas[row] += area
    triangle.getMidpoint(vector).multiplyScalar(area)
    for (let axis = 0; axis < 3; axis++) centers[offset + axis] += vector.getComponent(axis)
    triangle.getNormal(vector).multiplyScalar(area)
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] += vector.getComponent(axis)
  }
  for (let row = 0; row < rows.size; row++) {
    for (let axis = 0; axis < 3; axis++) {
      const at = row * 3 + axis
      centers[at] = areas[row] ? centers[at] / areas[row] : (minimums[at] + maximums[at]) / 2
      if (areas[row]) normals[at] /= areas[row]
    }
  }
  const order = Uint32Array.from(surfaceIds, (_, i) => i)
  order.sort((a, b) => areas[b] - areas[a] || surfaceIds[a] - surfaceIds[b])
  return { boundsMm: [...bounds.min.toArray(), ...bounds.max.toArray()],
    surfaces: { order, surfaceIds, triangles, areas, centers, normals, minimums, maximums } }
}

const model = await parseUsdModel(workerData)
const parts = [], transfer = [model.positions.buffer]
let firstFace = 0
model.root.traverseVisible(node => {
  if (!node.isMesh) return
  const triangles = (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3
  if (!triangles) return
  // buildModel emits these saved millimetre/Z-up vertices in the same traversal and face order.
  const { boundsMm, surfaces } = measurePart(node, model.positions.subarray(firstFace * 9, (firstFace + triangles) * 9))
  parts.push({ partPath: modelPartPath(node, null), triangles, firstFace, boundsMm, surfaces })
  transfer.push(...Object.values(surfaces).map(column => column.buffer))
  firstFace += triangles
})
parentPort.postMessage({ positions: model.positions, parts }, transfer)
