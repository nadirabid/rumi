/** Geometry checks measure a mesh and never certify it; a build volume is optional context. */
import { describe, expect, it } from 'vitest'
import { analyzeMesh } from '../viewer/checks.js'

const volume = { x: 325, y: 320, z: 325 }

function box(x = 12, y = 12, z = 2, origin = [0, 0, 0]) {
  const points = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]]
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  return new Float32Array(triangles.flatMap(face => face.flatMap(vertex => points[vertex].map((value, axis) => value + origin[axis]))))
}

function codes(positions: ArrayLike<number>, options = {}) {
  return analyzeMesh(positions, options).checks.map(check => check.code)
}

describe('mesh checks', () => {
  it('measures a watertight tile without mutating it or claiming print readiness', () => {
    const positions = box()
    const original = positions.slice()
    const result = analyzeMesh(positions)
    expect(result).toMatchObject({
      status: 'review',
      dimensions: { x: 12, y: 12, z: 2 },
      triangleCount: 12,
      volume: null,
      suggested: { scale: null, rotate: false },
    })
    expect(result.checks).toEqual([
      { code: 'blender_validation', severity: 'pending', data: {} },
    ])
    expect(positions).toEqual(original)
  })

  it('adds fit checks and an explicit pending slice only when a build volume is given', () => {
    const result = analyzeMesh(box(), { volume })
    expect(result.checks.map(check => [check.code, check.severity])).toEqual([
      ['size_ok', 'ok'], ['blender_validation', 'pending'], ['slicer_verification', 'pending'],
    ])
    expect(result.status).toBe('review')
    expect(analyzeMesh(box(), { volume: { x: 5, y: 320, z: 325 } })).toMatchObject({ status: 'blocked', suggested: { scale: 5 / 12, rotate: true } })
  })

  it('offers a fit by rotation when one axis is too long and the others allow it', () => {
    const result = analyzeMesh(box(300, 325, 10), { volume })
    expect(result.status).toBe('blocked')
    expect(result.suggested).toEqual({ scale: 320 / 325, rotate: true })
    expect(result.checks.find(check => check.code === 'oversized')).toMatchObject({ data: { volume } })
  })

  it('offers no rotation when the longest dimension exceeds every build axis', () => {
    const result = analyzeMesh(box(400, 12, 2), { volume })
    expect(result.suggested.rotate).toBe(false)
    expect(result.suggested.scale).toBeCloseTo(325 / 400)
  })

  it('uses dimensions rather than an arbitrary file origin for fit checks', () => {
    const result = analyzeMesh(box(12, 12, 2, [-500, 2500, 100]), { volume })
    expect(result.dimensions).toEqual({ x: 12, y: 12, z: 2 })
    expect(result.bounds).toEqual({ min: { x: -500, y: 2500, z: 100 }, max: { x: -488, y: 2512, z: 102 } })
    expect(result.checks.some(check => check.code === 'oversized')).toBe(false)
  })

  it('defers topology, intersection and overhang analysis to Blender', () => {
    for (const positions of [box().slice(9), [...box(), ...box()], [...box(), ...box(4, 4, 4, [20, 0, 20])]]) {
      expect(analyzeMesh(positions).checks).toEqual([{ code: 'blender_validation', severity: 'pending', data: {} }])
      expect(analyzeMesh(positions).status).toBe('review')
    }
    expect(codes([0, 0, 0, 12, 0, 0, 12, 12, 0])).toContain('flat_mesh')
  })

  it('rejects empty, partial, non-finite, and excessively complex input before topology work', () => {
    for (const positions of [[], [0, 0, 0], [NaN, 0, 0, 1, 0, 0, 0, 1, 0], [Infinity, 0, 0, 1, 0, 0, 0, 1, 0]]) {
      expect(analyzeMesh(positions)).toMatchObject({
        status: 'blocked', triangleCount: 0, suggested: { scale: null, rotate: false },
        checks: [{ code: 'invalid_mesh', severity: 'error' }],
      })
    }
    expect(analyzeMesh(box(), { maxTriangles: 2 }).checks[0].data).toEqual({ reason: 'too_complex' })
  })

  it('rejects invalid build volumes and geometric thresholds', () => {
    expect(() => analyzeMesh(box(), { volume: { x: 0, y: 320, z: 325 } })).toThrow(RangeError)
    expect(() => analyzeMesh(box(), { volume: { x: 1, y: 2 } })).toThrow(RangeError)
    expect(() => analyzeMesh(box(), { weldToleranceMm: 0 })).toThrow(RangeError)
  })
})
