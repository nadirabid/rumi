/**
 * Geometry measured from triangle positions in millimetres, Z up.
 *
 * Every finding is a measurement, never an endorsement: a slicer still has to
 * verify walls, self-intersections, supports, nozzle clearance, and the chosen
 * material. The build volume is optional, and without it the checks say nothing
 * about a printer.
 */

/** Tolerance used to weld coincident vertices, and the smallest measurable feature. */
const DEFAULT_WELD_MM = 0.001

/** Downward-facing surfaces steeper than this are reported as possible supports. */
const DEFAULT_OVERHANG_DEGREES = 45

/** Processing bound, matching the decoder's triangle cap. */
const DEFAULT_MAX_TRIANGLES = 200_000

function volumeProblem(volume) {
  if (volume === null) return null
  const positive = typeof volume === 'object' && ['x', 'y', 'z'].every(axis => Number.isFinite(volume[axis]) && volume[axis] > 0)
  return positive ? null : new RangeError('Build volume must contain positive finite millimetre dimensions')
}

/**
 * Inspect non-indexed triangle positions without mutating them.
 *
 * Topology welds coincident vertices at `weldToleranceMm`, and overhangs use a
 * 45° threshold while excluding faces lying on the lowest plane. Neither test
 * detects self-intersections, minimum wall thickness, bridges, or material
 * behaviour.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets, three vertices per triangle.
 * @param {{volume?: {x: number, y: number, z: number} | null, weldToleranceMm?: number, overhangAngleDegrees?: number, maxTriangles?: number}} [options] - Optional build volume; optional thresholds and processing bound.
 * @returns {{status: 'ok' | 'review' | 'blocked', dimensions: {x: number, y: number, z: number}, bounds: {min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}}, triangleCount: number, volume: {x: number, y: number, z: number} | null, suggested: {scale: number | null, rotate: boolean}, checks: {code: string, severity: 'ok' | 'warning' | 'error' | 'pending', data: object}[]}} Measured geometry and stable finding codes; status never certifies print readiness.
 */
export function analyzeMesh(positions, options = {}) {
  const {
    volume = null, weldToleranceMm = DEFAULT_WELD_MM,
    overhangAngleDegrees = DEFAULT_OVERHANG_DEGREES, maxTriangles = DEFAULT_MAX_TRIANGLES,
  } = options
  const badVolume = volumeProblem(volume)
  if (badVolume !== null) throw badVolume
  if (!Number.isFinite(weldToleranceMm) || weldToleranceMm <= 0
    || !Number.isFinite(overhangAngleDegrees) || overhangAngleDegrees <= 0 || overhangAngleDegrees >= 90
    || !Number.isSafeInteger(maxTriangles) || maxTriangles < 1) {
    throw new RangeError('Mesh analysis thresholds must be finite and within their documented ranges')
  }
  const candidate = { scale: null, rotate: false }
  const invalid = reason => ({
    status: 'blocked',
    dimensions: { x: 0, y: 0, z: 0 },
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    triangleCount: 0, volume, suggested: candidate,
    checks: [
      { code: 'invalid_mesh', severity: 'error', data: { reason } },
      ...(volume === null ? [] : [{ code: 'slicer_verification', severity: 'pending', data: {} }]),
    ],
  })
  if (!positions || !Number.isSafeInteger(positions.length) || positions.length === 0) return invalid('empty')
  if (positions.length % 9 !== 0) return invalid('not_triangles')
  if (positions.length / 9 > maxTriangles) return invalid('too_complex')
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i]
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value / weldToleranceMm))) return invalid('non_finite')
    const axis = i % 3
    min[axis] = Math.min(min[axis], value)
    max[axis] = Math.max(max[axis], value)
  }
  const dimensions = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] }
  const triangleCount = positions.length / 9
  const checks = []
  if (volume !== null) {
    const fits = size => [size.x, size.y, size.z].every((value, axis) => value <= [volume.x, volume.y, volume.z][axis] + weldToleranceMm)
    if (fits(dimensions)) {
      checks.push({ code: 'size_ok', severity: 'ok', data: { dimensions, volume } })
    } else {
      const ordered = [dimensions.x, dimensions.y, dimensions.z]
      candidate.scale = Math.min(1, ...['x', 'y', 'z'].map(axis => dimensions[axis] > 0 ? volume[axis] / dimensions[axis] : 1))
      candidate.rotate = [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
        .some(([a, b, c]) => fits({ x: ordered[a], y: ordered[b], z: ordered[c] }))
      checks.push({ code: 'oversized', severity: 'error', data: { dimensions, volume } })
    }
  }
  if (dimensions.x <= weldToleranceMm || dimensions.y <= weldToleranceMm || dimensions.z <= weldToleranceMm) {
    checks.push({ code: 'flat_mesh', severity: 'error', data: { dimensions } })
  }

  const vertexIds = new Map()
  const edges = new Map()
  const faces = new Set()
  const parents = Array.from({ length: triangleCount }, (_, index) => index)
  const root = vertex => {
    while (parents[vertex] !== vertex) {
      parents[vertex] = parents[parents[vertex]]
      vertex = parents[vertex]
    }
    return vertex
  }
  const join = (a, b) => { parents[root(a)] = root(b) }
  let degenerate = 0
  let duplicates = 0
  let overhangs = 0
  let overhangAreaMm2 = 0
  let validFaces = 0
  const activeFaces = []
  const threshold = -Math.cos(overhangAngleDegrees * Math.PI / 180)
  for (let offset = 0; offset < positions.length; offset += 9) {
    const face = offset / 9
    const ids = []
    for (let vertex = 0; vertex < 3; vertex++) {
      const start = offset + vertex * 3
      const key = [0, 1, 2].map(axis => Math.round(positions[start + axis] / weldToleranceMm)).join(',')
      if (!vertexIds.has(key)) vertexIds.set(key, vertexIds.size)
      ids.push(vertexIds.get(key))
    }
    const ax = positions[offset + 3] - positions[offset]
    const ay = positions[offset + 4] - positions[offset + 1]
    const az = positions[offset + 5] - positions[offset + 2]
    const bx = positions[offset + 6] - positions[offset]
    const by = positions[offset + 7] - positions[offset + 1]
    const bz = positions[offset + 8] - positions[offset + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const doubleArea = Math.hypot(nx, ny, nz)
    if (new Set(ids).size < 3 || doubleArea <= weldToleranceMm ** 2) {
      degenerate++
      continue
    }
    const faceKey = [...ids].sort((a, b) => a - b).join(',')
    if (faces.has(faceKey)) duplicates++
    faces.add(faceKey)
    validFaces++
    activeFaces.push(face)
    const onBed = [2, 5, 8].every(axis => Math.abs(positions[offset + axis] - min[2]) <= weldToleranceMm)
    if (!onBed && nz / doubleArea < threshold) {
      overhangs++
      overhangAreaMm2 += doubleArea / 2
    }
    for (let vertex = 0; vertex < 3; vertex++) {
      const a = ids[vertex]
      const b = ids[(vertex + 1) % 3]
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const direction = a < b ? 1 : -1
      const edge = edges.get(key)
      if (edge) {
        edge.count++
        edge.direction += direction
        join(face, edge.face)
      } else edges.set(key, { count: 1, direction, face })
    }
  }
  let openEdges = 0
  let nonManifoldEdges = 0
  let windingEdges = 0
  for (const edge of edges.values()) {
    if (edge.count === 1) openEdges++
    if (edge.count > 2) nonManifoldEdges++
    if (edge.count === 2 && edge.direction !== 0) windingEdges++
  }
  const shells = new Set(activeFaces.map(root)).size
  for (const [code, count] of [
    ['degenerate_faces', degenerate], ['duplicate_faces', duplicates],
    ['open_edges', openEdges], ['non_manifold_edges', nonManifoldEdges],
  ]) {
    if (count) checks.push({ code, severity: 'error', data: { count } })
  }
  if (validFaces && !degenerate && !duplicates && !openEdges && !nonManifoldEdges && !windingEdges) {
    checks.push({ code: 'topology_ok', severity: 'ok', data: { toleranceMm: weldToleranceMm } })
  }
  if (windingEdges) checks.push({ code: 'inconsistent_winding', severity: 'warning', data: { count: windingEdges } })
  if (shells > 1) checks.push({ code: 'multiple_shells', severity: 'warning', data: { count: shells } })
  if (overhangs) {
    checks.push({ code: 'overhangs', severity: 'warning', data: { count: overhangs, areaMm2: overhangAreaMm2, angleDegrees: overhangAngleDegrees } })
  }
  if (volume !== null) checks.push({ code: 'slicer_verification', severity: 'pending', data: {} })
  const status = checks.some(check => check.severity === 'error')
    ? 'blocked'
    : checks.some(check => check.severity === 'warning') ? 'review' : 'ok'
  return {
    status,
    dimensions,
    bounds: { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
    triangleCount,
    volume,
    suggested: candidate,
    checks,
  }
}
