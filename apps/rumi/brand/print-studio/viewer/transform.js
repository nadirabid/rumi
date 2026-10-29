/**
 * Placement math for one scene object.
 *
 * A placement is uniform scale, a rotation in degrees about the X, Y, and Z
 * axes (applied in that order), and a position. Scale and rotation turn the
 * mesh about its bounding-box centre; `position` then says where the mesh's
 * bottom centre sits, so a scaled or turned part stays on the plate instead of
 * sinking through it.
 *
 * One matrix serves every consumer: baking composes it into vertices, measuring
 * composes it before analysing, and the viewport hands it to the renderer
 * unchanged. Nothing else may re-implement it.
 */

const AXES = ['x', 'y', 'z']

/** A placement that changes nothing: file coordinates, seated at the plate centre. */
export const IDENTITY = Object.freeze({
  scale: 1,
  rotate: Object.freeze({ x: 0, y: 0, z: 0 }),
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
})

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`)
  return value
}

/**
 * Validate a placement and fill in the omitted parts.
 * @param {{scale?: number, rotate?: {x?: number, y?: number, z?: number}, position?: {x?: number, y?: number, z?: number}}} [placement] - Omitted parts keep the identity value; `position` is millimetres.
 * @returns {{scale: number, rotate: {x: number, y: number, z: number}, position: {x: number, y: number, z: number}}} the placement in canonical form.
 * @throws {RangeError} A non-finite value or a non-positive scale.
 */
export function normalizePlacement(placement = {}) {
  const scale = finite(placement.scale ?? 1, 'scale')
  if (scale <= 0) throw new RangeError('scale must be greater than zero')
  return {
    scale,
    rotate: Object.fromEntries(AXES.map(axis => [axis, finite(placement.rotate?.[axis] ?? 0, `rotate.${axis}`)])),
    position: Object.fromEntries(AXES.map(axis => [axis, finite(placement.position?.[axis] ?? 0, `position.${axis}`)])),
  }
}

/** Element-wise bounds of unindexed triangle positions. */
function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3
    if (positions[i] < min[axis]) min[axis] = positions[i]
    if (positions[i] > max[axis]) max[axis] = positions[i]
  }
  return { min, max }
}

/**
 * The bounding-box centre of unindexed triangle positions.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets.
 * @returns {[number, number, number]} the centre in millimetres.
 */
export function centreOf(positions) {
  const { min, max } = boundsOf(positions)
  return [0, 1, 2].map(axis => (min[axis] + max[axis]) / 2)
}

function multiply(a, b) {
  return a.map((row, i) => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)))
}

/** The column-major matrix of a scale and rotation about `centre`, without translation. */
function placementMatrix(placement, centre) {
  const [x, y, z] = AXES.map(axis => placement.rotate[axis] * Math.PI / 180)
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)]
  const r = multiply(
    multiply([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]),
    [[1, 0, 0], [0, cx, -sx], [0, sx, cx]],
  )
  const scale = placement.scale
  const [ax, ay, az] = centre
  const translation = AXES.map((_, i) => [ax, ay, az][i] - scale * (r[i][0] * ax + r[i][1] * ay + r[i][2] * az))
  return [
    r[0][0] * scale, r[1][0] * scale, r[2][0] * scale, 0,
    r[0][1] * scale, r[1][1] * scale, r[2][1] * scale, 0,
    r[0][2] * scale, r[1][2] * scale, r[2][2] * scale, 0,
    translation[0], translation[1], translation[2], 1,
  ]
}

/**
 * Apply a column-major matrix to unindexed triangle positions.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets, three vertices per triangle.
 * @param {number[]} matrix - Sixteen numbers in column-major order.
 * @returns {Float32Array} Transformed positions.
 */
export function applyMatrix(positions, matrix) {
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]]
    out[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    out[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    out[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  }
  return out
}

/**
 * Place a mesh for rendering, measuring, and baking.
 *
 * Scale and rotation turn the mesh about its centre; the result is then seated
 * so its bottom centre sits at the placement's position.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets, three vertices per triangle.
 * @param {{scale?: number, rotate?: {x?: number, y?: number, z?: number}, position?: {x?: number, y?: number, z?: number}}} [placement] - Placement to apply.
 * @returns {{matrix: number[], positions: Float32Array}} the renderer matrix and the placed geometry.
 * @throws {RangeError} A non-finite value, a non-positive scale, or positions that are not whole triangles.
 */
export function placeMesh(positions, placement = {}) {
  if (!Number.isSafeInteger(positions.length) || positions.length % 9 !== 0) {
    throw new RangeError('placeMesh expects whole triangles')
  }
  const normalized = normalizePlacement(placement)
  const base = placementMatrix(normalized, centreOf(positions))
  const moved = applyMatrix(positions, base)
  const { min, max } = boundsOf(moved)
  const offset = [
    normalized.position.x - (min[0] + max[0]) / 2,
    normalized.position.y - (min[1] + max[1]) / 2,
    normalized.position.z - min[2],
  ]
  // `moved` already carries the about-centre translation, so the seat only adds to it.
  const matrix = base.slice()
  matrix[12] = base[12] + offset[0]
  matrix[13] = base[13] + offset[1]
  matrix[14] = base[14] + offset[2]
  const seated = new Float32Array(moved.length)
  for (let i = 0; i < moved.length; i += 3) {
    seated[i] = moved[i] + offset[0]
    seated[i + 1] = moved[i + 1] + offset[1]
    seated[i + 2] = moved[i + 2] + offset[2]
  }
  return { matrix, positions: seated }
}
