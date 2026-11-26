/** Measure the viewer's connected surfaces off the host thread and return transferable triangle data. */
import { parentPort, workerData } from 'node:worker_threads'
import { Box3, Triangle, Vector3 } from 'three'
import { modelPartPath } from './viewport/cursor-geometry.js'
import { createNamedRegionIndex } from './viewport/named-regions.js'
import { createSurfaceIndex } from './viewport/surfaces.js'
import { parseUsdModel } from './viewport/usd.js'

function coveredFaces(root, regions) {
  const index = createNamedRegionIndex(root, null, regions)
  const masks = new Map(), unresolvedIds = []
  for (const region of regions) {
    if (region.location.kind !== 'surface') continue
    const resolved = index.get(region.id)
    if (!resolved) {
      unresolvedIds.push(region.id)
      continue
    }
    // The viewer requires each child to be contained in its parent.
    if (region.parentId) continue
    for (const [node, faces] of resolved.selectors) {
      const mask = masks.get(node)
      if (mask) {
        for (let face = 0; face < faces.length; face++) mask[face] |= faces[face]
      } else masks.set(node, faces.slice())
    }
  }
  return { masks, unresolvedIds }
}

function addUncoveredFace(gaps, row, face, area, corners) {
  let gap = gaps.get(row)
  if (!gap) {
    gap = { triangles: 0, areaMm2: 0, bounds: new Box3(), faceRanges: [] }
    gaps.set(row, gap)
  }
  gap.triangles++
  gap.areaMm2 += area
  for (const point of corners) gap.bounds.expandByPoint(point)
  const last = gap.faceRanges.at(-1)
  if (last?.[1] === face) last[1]++
  else gap.faceRanges.push([face, face + 1])
}

function measurePart(node, vertices, covered) {
  const index = node.geometry.userData.rumiSurfaceIndex ?? createSurfaceIndex(node.geometry)
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
  const gaps = covered ? new Map() : null
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
    if (gaps && !covered[face]) addUncoveredFace(gaps, row, face, area, corners)
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
  const uncovered = gaps && Array.from(gaps, ([row, gap]) => ({
    surfaceId: surfaceIds[row], surfaceTriangles: triangles[row], triangles: gap.triangles,
    areaMm2: gap.areaMm2, boundsMm: [...gap.bounds.min.toArray(), ...gap.bounds.max.toArray()], faceRanges: gap.faceRanges,
  })).sort((a, b) => b.areaMm2 - a.areaMm2 || a.surfaceId - b.surfaceId)
  return { boundsMm: [...bounds.min.toArray(), ...bounds.max.toArray()],
    surfaces: { order, surfaceIds, triangles, areas, centers, normals, minimums, maximums },
    coverage: uncovered && {
      areaMm2: areas.reduce((sum, area) => sum + area, 0),
      uncoveredAreaMm2: uncovered.reduce((sum, gap) => sum + gap.areaMm2, 0),
      uncoveredTriangles: uncovered.reduce((sum, gap) => sum + gap.triangles, 0),
      surfaces: uncovered,
    },
  }
}

const model = await parseUsdModel(workerData.bytes)
if (workerData.selectorsOnly) {
  const index = createNamedRegionIndex(model.root, null, workerData.regions)
  parentPort.postMessage({ unresolved: workerData.regions.some(region => !index.get(region.id)) })
} else measureModel()

function measureModel() {
  const parts = [], partCoverage = [], transfer = [model.positions.buffer]
  let audit
  if (workerData.regions) {
    model.root.traverseVisible(node => {
      if (node.isMesh) node.geometry.userData.rumiSurfaceIndex ??= createSurfaceIndex(node.geometry)
    })
    audit = coveredFaces(model.root, workerData.regions)
  }
  let firstFace = 0
  model.root.traverseVisible(node => {
    if (!node.isMesh) return
    const triangles = (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3
    if (!triangles) return
    // buildModel emits these saved millimetre/Z-up vertices in the same traversal and face order.
    const mask = audit && (audit.masks.get(node) ?? new Uint8Array(triangles))
    const { boundsMm, surfaces, coverage } = measurePart(node, model.positions.subarray(firstFace * 9, (firstFace + triangles) * 9), mask)
    const partPath = modelPartPath(node, null)
    parts.push({ partPath, triangles, firstFace, boundsMm, surfaces })
    if (coverage) partCoverage.push({ partPath, triangles, ...coverage })
    transfer.push(...Object.values(surfaces).map(column => column.buffer))
    firstFace += triangles
  })
  const coverage = audit && {
    unresolvedIds: audit.unresolvedIds,
    triangles: firstFace,
    uncoveredTriangles: partCoverage.reduce((sum, part) => sum + part.uncoveredTriangles, 0),
    areaMm2: partCoverage.reduce((sum, part) => sum + part.areaMm2, 0),
    uncoveredAreaMm2: partCoverage.reduce((sum, part) => sum + part.uncoveredAreaMm2, 0),
    parts: partCoverage,
  }
  parentPort.postMessage({ positions: model.positions, parts, ...(coverage ? { coverage } : {}) }, transfer)
}
