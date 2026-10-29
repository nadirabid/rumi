/** Baking is the only place a placement becomes geometry, so exported and measured meshes agree. */
import { describe, expect, it } from 'vitest'
import { bakeScene } from '../viewer/bake.js'
import { createHistory } from '../viewer/document.js'

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

function fixture() {
  const history = createHistory()
  const datablocks = new Map([['d1', { positions: box() }]])
  history.apply({ type: 'addObject', datablockId: 'd1', name: 'box.stl' })
  return { history, datablocks }
}

describe('bake', () => {
  it('emits one mesh per visible object with its transform applied', () => {
    const { history, datablocks } = fixture()
    const scene = history.current()
    const object = scene.objects[0]
    history.apply({ type: 'setTransform', objectId: object.id, scale: 2, rotate: { z: 90 } })
    const [mesh] = bakeScene(history.current(), datablocks)
    expect(mesh.name).toBe('box.stl')
    expect(mesh.objectId).toBe(object.id)
    // A 12x12x2 box turned 90 degrees about Z is still 12x12x2, at double size.
    expect(extent(mesh.positions).size.map(value => Math.round(value))).toEqual([24, 24, 4])
  })

  it('keeps the same datablock as separate meshes for each placement', () => {
    const { history, datablocks } = fixture()
    const second = history.apply({ type: 'addObject', datablockId: 'd1', name: 'box.stl' })
    const meshes = bakeScene(history.current(), datablocks)
    expect(meshes).toHaveLength(2)
    expect(meshes.map(mesh => mesh.name)).toEqual(['box.stl', 'box-2.stl'])
    expect(meshes[0].objectId).toBe(second.objects[0].id)
  })

  it('leaves hidden objects out of the printable set', () => {
    const { history, datablocks } = fixture()
    const object = history.current().objects[0]
    history.apply({ type: 'setVisible', objectId: object.id, visible: false })
    expect(bakeScene(history.current(), datablocks)).toEqual([])
  })

  it('fails loudly when the scene references geometry it does not have', () => {
    const { history } = fixture()
    expect(() => bakeScene(history.current(), new Map())).toThrow(RangeError)
  })
})
