/** Placement is shared: the matrix the renderer receives is the one baking and measuring apply. */
import { describe, expect, it } from 'vitest'
import { applyMatrix, normalizePlacement, placeMesh } from '../viewer/transform.js'

function box(x = 12, y = 12, z = 2) {
  const points = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]]
  const triangles = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  return new Float32Array(triangles.flatMap(face => face.flatMap(vertex => points[vertex].flat())))
}

function extent(positions: ArrayLike<number>) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i])
    max[i % 3] = Math.max(max[i % 3], positions[i])
  }
  return { min, max, size: max.map((value, axis) => value - min[axis]) }
}

describe('placement', () => {
  it('fills in the identity for omitted parts', () => {
    expect(normalizePlacement()).toEqual({ scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } })
  })

  it('seats a mesh on the plate, centred in X and Y', () => {
    const { positions } = placeMesh(box())
    const { min, max, size } = extent(positions)
    expect(min[0]).toBeCloseTo(-6)
    expect(min[1]).toBeCloseTo(-6)
    expect(min[2]).toBeCloseTo(0)
    expect(max[2]).toBeCloseTo(2)
    expect(size.map(value => Math.round(value))).toEqual([12, 12, 2])
  })

  it('scales a part upward from the plate instead of sinking it', () => {
    const { positions } = placeMesh(box(), { scale: 2 })
    const { min, max, size } = extent(positions)
    expect(min[2]).toBeCloseTo(0)
    expect(max[2]).toBeCloseTo(4)
    expect(size.map(value => Math.round(value))).toEqual([24, 24, 4])
  })

  it('turns a part about its centre and keeps it seated', () => {
    const { positions, matrix } = placeMesh(box(), { rotate: { x: 90 } })
    const { min, size } = extent(positions)
    expect(min[2]).toBeCloseTo(0)
    expect(size.map(value => Math.round(value))).toEqual([12, 2, 12])
    // The renderer receives the same seated matrix that produced these vertices.
    const rendered = applyMatrix(box(), matrix)
    for (let i = 0; i < rendered.length; i++) expect(rendered[i]).toBeCloseTo(positions[i], 5)
  })

  it('places the bottom centre where the caller asked', () => {
    const { positions } = placeMesh(box(), { position: { x: 25, y: -5, z: 3 } })
    const { min, max } = extent(positions)
    expect(min[2]).toBeCloseTo(3)
    expect((min[0] + max[0]) / 2).toBeCloseTo(25)
    expect((min[1] + max[1]) / 2).toBeCloseTo(-5)
  })

  it('rejects a non-positive scale, non-finite values, and partial triangles', () => {
    expect(() => placeMesh(box(), { scale: 0 })).toThrow(RangeError)
    expect(() => placeMesh(box(), { scale: -1 })).toThrow(RangeError)
    expect(() => placeMesh(box(), { rotate: { x: Infinity } })).toThrow(RangeError)
    expect(() => placeMesh([0, 0, 0], {})).toThrow(RangeError)
  })
})
