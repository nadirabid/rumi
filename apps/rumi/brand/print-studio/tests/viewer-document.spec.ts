/** The scene document is plain data; every change is a command, so undo is just an earlier document. */
import { describe, expect, it } from 'vitest'
import { applyCommand, createHistory, createScene } from '../viewer/document.js'

const volume = { x: 300, y: 320, z: 320 }

function withBox() {
  const history = createHistory()
  const scene = history.apply({ type: 'addObject', datablockId: 'd1', name: 'box.stl', position: { x: -6, y: -6, z: 0 } })
  return { history, scene, objectId: scene.objects[0].id }
}

describe('scene document', () => {
  it('starts empty with no print context', () => {
    expect(createScene()).toEqual({ objects: [], volume: null, revision: 0 })
  })

  it('places an object where the caller seats it and gives it an identity placement otherwise', () => {
    const { scene } = withBox()
    expect(scene.objects[0]).toMatchObject({
      datablockId: 'd1', name: 'box.stl', visible: true,
      transform: { scale: 1, position: { x: -6, y: -6, z: 0 } },
    })
    const plain = applyCommand(scene, { type: 'addObject', datablockId: 'd2', name: 'other.stl' })
    expect(plain.objects[1].transform).toEqual({ scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } })
  })

  it('lets one datablock be placed many times, which is what a parts library is', () => {
    const { history } = withBox()
    const scene = history.apply({ type: 'addObject', datablockId: 'd1', name: 'box.stl' })
    expect(scene.objects.filter(object => object.datablockId === 'd1')).toHaveLength(2)
  })

  it('replaces the placement parts it is given and keeps the rest', () => {
    const { history, objectId } = withBox()
    history.apply({ type: 'setTransform', objectId, scale: 2 })
    const scene = history.apply({ type: 'setTransform', objectId, rotate: { z: 90 } })
    expect(scene.objects[0].transform).toEqual({ scale: 2, rotate: { x: 0, y: 0, z: 90 }, position: { x: -6, y: -6, z: 0 } })
  })

  it('bumps the revision and returns a new document for every command', () => {
    const { history, scene, objectId } = withBox()
    const next = history.apply({ type: 'setVisible', objectId, visible: false })
    expect(next).not.toBe(scene)
    expect(next.revision).toBe(scene.revision + 1)
    expect(next.objects[0].visible).toBe(false)
  })

  it('walks back and forward over the command history', () => {
    const { history, objectId } = withBox()
    history.apply({ type: 'setTransform', objectId, scale: 2 })
    expect(history.canUndo()).toBe(true)
    expect(history.undo().objects[0].transform.scale).toBe(1)
    expect(history.canRedo()).toBe(true)
    expect(history.redo().objects[0].transform.scale).toBe(2)
    expect(history.undo().objects[0].transform.scale).toBe(1)
  })

  it('drops the redo branch when a new command lands', () => {
    const { history, objectId } = withBox()
    history.apply({ type: 'setTransform', objectId, scale: 2 })
    history.undo()
    expect(history.canRedo()).toBe(true)
    history.apply({ type: 'setVisible', objectId, visible: false })
    expect(history.canRedo()).toBe(false)
  })

  it('rejects commands that name a missing object or an invalid value', () => {
    const { history, objectId } = withBox()
    expect(() => history.apply({ type: 'setTransform', objectId: 'nope', scale: 2 })).toThrow(RangeError)
    expect(() => history.apply({ type: 'removeObject', objectId: 'nope' })).toThrow(RangeError)
    expect(() => history.apply({ type: 'setTransform', objectId, scale: 0 })).toThrow(RangeError)
    expect(() => history.apply({ type: 'setVolume', volume: { x: 0, y: 1, z: 1 } })).toThrow(RangeError)
    expect(() => history.apply({ type: 'nonsense' })).toThrow(RangeError)
  })

  it('clears and sets the print context', () => {
    const { history } = withBox()
    expect(history.apply({ type: 'setVolume', volume }).volume).toEqual(volume)
    expect(history.apply({ type: 'setVolume', volume: null }).volume).toBeNull()
  })
})
