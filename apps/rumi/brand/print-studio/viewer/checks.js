/**
 * Bounds and input guards for triangle positions in millimetres, Z up.
 *
 * Geometry analysis belongs to the explicit Blender validation tools. These synchronous
 * measurements keep the viewer renderable and never establish print readiness.
 */

/** Tolerance used to weld coincident vertices, and the smallest measurable feature. */
const DEFAULT_WELD_MM = 0.001

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
 * Reports dimensions and optional envelope fit while Blender validation is pending.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets, three vertices per triangle.
 * @param {{volume?: {x: number, y: number, z: number} | null, weldToleranceMm?: number, maxTriangles?: number}} [options] - Optional build volume; optional thresholds and processing bound.
 * @returns {{status: 'ok' | 'review' | 'blocked', dimensions: {x: number, y: number, z: number}, bounds: {min: {x: number, y: number, z: number}, max: {x: number, y: number, z: number}}, triangleCount: number, volume: {x: number, y: number, z: number} | null, suggested: {scale: number | null, rotate: boolean}, checks: {code: string, severity: 'ok' | 'warning' | 'error' | 'pending', data: object}[]}} Measured geometry and stable finding codes; status never certifies print readiness.
 */
export function analyzeMesh(positions, options = {}) {
  const {
    volume = null, weldToleranceMm = DEFAULT_WELD_MM,
    maxTriangles = DEFAULT_MAX_TRIANGLES,
  } = options
  const badVolume = volumeProblem(volume)
  if (badVolume !== null) throw badVolume
  if (!Number.isFinite(weldToleranceMm) || weldToleranceMm <= 0
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

  checks.push({ code: 'blender_validation', severity: 'pending', data: {} })
  if (volume !== null) checks.push({ code: 'slicer_verification', severity: 'pending', data: {} })
  const status = checks.some(check => check.severity === 'error')
    ? 'blocked'
    : checks.some(check => check.severity === 'warning' || check.severity === 'pending') ? 'review' : 'ok'
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
