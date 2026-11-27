/**
 * The scene document: what the viewport shows, as plain data.
 *
 * A datablock is geometry — one mesh, identified by `datablockId` and owned by
 * the host; this document never holds bytes. An object places one datablock in
 * the scene with a transform. The scene is its objects plus the print context
 * they are checked against.
 *
 * Every change is a command, whether it comes from the agent or, later, from a
 * gizmo. Commands return a new document, so undo is a list of earlier documents
 * rather than a set of inverse operations.
 */
import { normalizePlacement } from './transform.js'

/** Deep enough for a working session and cheap to keep, since each entry is a small document. */
const HISTORY_LIMIT = 64

function newId() {
  return crypto.randomUUID()
}

function objectIn(scene, objectId) {
  const object = scene.objects.find(candidate => candidate.id === objectId)
  if (object === undefined) throw new RangeError(`scene has no object ${objectId}`)
  return object
}

function volumeOrNull(volume) {
  if (volume === null || volume === undefined) return null
  const valid = ['x', 'y', 'z'].every(axis => Number.isFinite(volume[axis]) && volume[axis] > 0)
  if (!valid) throw new RangeError('Build volume must contain positive finite millimetre dimensions')
  return { x: volume.x, y: volume.y, z: volume.z }
}

/**
 * An empty scene with no print context.
 * @returns {{objects: object[], volume: null, revision: number}} the new document; the revision is the number of commands applied.
 */
export function createScene() {
  return { objects: [], volume: null, revision: 0 }
}

/**
 * Apply one command and return the next document.
 *
 * Supported commands are `addObject` (`datablockId`, `name`), `removeObject`
 * (`objectId`), `setTransform` (`objectId` plus any of `scale`, `rotate`,
 * `position`; each part given replaces that part of the placement and the rest
 * is kept), `setVisible` (`objectId`, `visible`), and `setVolume` (`volume`, or
 * `null`).
 * @param {{objects: object[], volume: object | null, revision: number}} scene - Current document.
 * @param {{type: string}} command - Command to apply; each type reads the fields named above.
 * @returns {{objects: object[], volume: object | null, revision: number}} the next document.
 * @throws {RangeError} An unknown command, a missing object, or an invalid value.
 */
export function applyCommand(scene, command) {
  const next = (objects, volume = scene.volume) => ({ objects, volume, revision: scene.revision + 1 })
  switch (command.type) {
    case 'addObject':
      // The same datablock may be placed many times; that is what a parts library is.
      return next([...scene.objects, {
        id: newId(), datablockId: command.datablockId, name: command.name,
        transform: normalizePlacement({ position: command.position }), visible: true,
      }])
    case 'removeObject': {
      objectIn(scene, command.objectId)
      return next(scene.objects.filter(object => object.id !== command.objectId))
    }
    case 'setTransform': {
      const object = objectIn(scene, command.objectId)
      const given = Object.fromEntries(
        ['scale', 'rotate', 'position'].filter(part => command[part] !== undefined).map(part => [part, command[part]]),
      )
      const transform = normalizePlacement({ ...object.transform, ...given })
      return next(scene.objects.map(candidate => candidate === object ? { ...object, transform } : candidate))
    }
    case 'setVisible': {
      const object = objectIn(scene, command.objectId)
      return next(scene.objects.map(candidate => candidate === object ? { ...object, visible: command.visible === true } : candidate))
    }
    case 'setVolume':
      return next(scene.objects, volumeOrNull(command.volume))
    default:
      throw new RangeError(`unknown scene command ${String(command.type)}`)
  }
}

/**
 * Keep a scene and the history of its commands.
 * @param {{objects: object[], volume: object | null, revision: number}} [initial] - Starting document.
 * @returns {{current: () => object, apply: (command: object) => object, undo: () => object, redo: () => object, canUndo: () => boolean, canRedo: () => boolean}} the history handle; every method that changes the document returns it.
 */
export function createHistory(initial = createScene()) {
  let scene = initial
  const past = []
  const future = []
  return {
    current: () => scene,
    apply(command) {
      const next = applyCommand(scene, command)
      past.push(scene)
      if (past.length > HISTORY_LIMIT) past.shift()
      future.length = 0
      scene = next
      return scene
    },
    undo() {
      const previous = past.pop()
      if (previous === undefined) return scene
      future.push(scene)
      scene = previous
      return scene
    },
    redo() {
      const next = future.pop()
      if (next === undefined) return scene
      past.push(scene)
      scene = next
      return scene
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  }
}
