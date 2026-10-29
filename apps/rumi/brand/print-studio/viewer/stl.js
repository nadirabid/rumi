/**
 * STL decoding plus the canonical mesh encoding the viewer renders.
 *
 * The host reads ASCII or binary STL from disk and always publishes
 * {@link encodeStl} output, so the browser has one parse path and the transport
 * never depends on how the file was written. Coordinates are millimetres; the
 * model is Z up.
 */

/** Fixed input safety limits; decoding never allocates beyond the triangle cap. */
export const STL_LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxTriangles: 200_000 })

/** A machine-readable file failure; the renderer owns localized explanations. */
export class StlError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StlError'
    this.code = code
  }
}

function numeric(token) {
  if (token === undefined || token.trim() === '') throw new StlError('invalid_stl')
  const value = Number(token)
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new StlError('non_finite_coordinates')
  return value
}

/**
 * Decode binary or ASCII STL into unindexed triangle positions, without normals.
 * @param {ArrayBuffer | Uint8Array} input - STL file bytes.
 * @returns {Float32Array} XYZ coordinates in millimetres, Z up.
 * @throws {StlError} Malformed, empty, oversized, or non-finite input.
 */
export function parseStl(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength > STL_LIMITS.maxBytes) throw new StlError('file_too_large')
  if (bytes.byteLength === 0) throw new StlError('invalid_stl')
  if (bytes.byteLength >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint32(80, true)
    if (84 + count * 50 === bytes.byteLength) {
      if (count === 0) throw new StlError('invalid_stl')
      if (count > STL_LIMITS.maxTriangles) throw new StlError('too_many_triangles')
      const positions = new Float32Array(count * 9)
      for (let face = 0; face < count; face++) {
        for (let axis = 0; axis < 9; axis++) {
          const value = view.getFloat32(84 + face * 50 + 12 + axis * 4, true)
          if (!Number.isFinite(value)) throw new StlError('non_finite_coordinates')
          positions[face * 9 + axis] = value
        }
      }
      return positions
    }
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Binary input with an inconsistent triangle count is not an ASCII fallback.
    throw new StlError('invalid_stl')
  }
  const positions = []
  let state = 'solid'
  let vertices = 0
  let triangles = 0
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const parts = line.split(/\s+/)
    if ((state === 'solid' || state === 'facet') && parts[0] === 'solid') { state = 'facet'; continue }
    if (state === 'facet' && parts[0] === 'endsolid') { state = 'solid'; continue }
    if (state === 'facet' && parts.length === 5 && parts[0] === 'facet' && parts[1] === 'normal') {
      parts.slice(2).forEach(numeric)
      state = 'loop'; continue
    }
    if (state === 'loop' && parts.length === 2 && parts[0] === 'outer' && parts[1] === 'loop') { vertices = 0; state = 'vertex'; continue }
    if (state === 'vertex' && parts.length === 4 && parts[0] === 'vertex') {
      positions.push(...parts.slice(1).map(numeric))
      if (++vertices === 3) state = 'endloop'
      continue
    }
    if (state === 'endloop' && line === 'endloop') { state = 'endfacet'; continue }
    if (state === 'endfacet' && line === 'endfacet') {
      if (++triangles > STL_LIMITS.maxTriangles) throw new StlError('too_many_triangles')
      state = 'facet'; continue
    }
    throw new StlError('invalid_stl')
  }
  if (state !== 'solid' || triangles === 0) throw new StlError('invalid_stl')
  return new Float32Array(positions)
}

/**
 * Encode triangle positions as binary STL: the format the viewer renders and
 * the only mesh encoding the host serves.
 * @param {ArrayLike<number>} positions - Flat XYZ triplets, three vertices per triangle.
 * @returns {ArrayBuffer} Binary STL bytes with one outward normal per facet.
 * @throws {RangeError} Positions that are not whole triangles within the limits.
 */
export function encodeStl(positions) {
  if (!Number.isSafeInteger(positions.length) || positions.length % 9 !== 0) {
    throw new RangeError('encodeStl expects whole triangles')
  }
  const count = positions.length / 9
  if (count > STL_LIMITS.maxTriangles) throw new RangeError('encodeStl input exceeds the triangle limit')
  const data = new ArrayBuffer(84 + count * 50)
  const view = new DataView(data)
  view.setUint32(80, count, true)
  for (let triangle = 0; triangle < count; triangle++) {
    const base = triangle * 9
    const ax = positions[base + 3] - positions[base]
    const ay = positions[base + 4] - positions[base + 1]
    const az = positions[base + 5] - positions[base + 2]
    const bx = positions[base + 6] - positions[base]
    const by = positions[base + 7] - positions[base + 1]
    const bz = positions[base + 8] - positions[base + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const length = Math.hypot(nx, ny, nz)
    const offset = 84 + triangle * 50
    if (length > 0) {
      view.setFloat32(offset, nx / length, true)
      view.setFloat32(offset + 4, ny / length, true)
      view.setFloat32(offset + 8, nz / length, true)
    }
    for (let axis = 0; axis < 9; axis++) {
      view.setFloat32(offset + 12 + axis * 4, positions[base + axis], true)
    }
  }
  return data
}
