/**
 * Bake the scene into printable meshes.
 *
 * The scene document is the working state; this is its projection onto files.
 * A transform becomes geometry here and nowhere else, so an exported mesh and a
 * measured mesh cannot disagree.
 */
import { placeMesh } from './transform.js'

/** A file name that does not collide with the meshes already named in this bake. */
function nameFor(name, taken) {
  const base = name.replace(/\.stl$/iu, '')
  if (!taken.has(`${base}.stl`)) return `${base}.stl`
  for (let index = 2; ; index++) {
    const candidate = `${base}-${index}.stl`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Project every visible object into its own printable mesh.
 * @param {{objects: {id: string, datablockId: string, name: string, transform: object, visible: boolean}[], volume: object | null}} scene - Scene document.
 * @param {Map<string, {positions: ArrayLike<number>}>} datablocks - Geometry by datablock id.
 * @returns {{objectId: string, name: string, positions: Float32Array}[]} one transformed mesh per visible object, in scene order.
 * @throws {RangeError} A visible object whose datablock is missing, or an invalid placement.
 */
export function bakeScene(scene, datablocks) {
  const meshes = []
  const taken = new Set()
  for (const object of scene.objects) {
    if (!object.visible) continue
    const datablock = datablocks.get(object.datablockId)
    if (datablock === undefined) throw new RangeError(`scene references unknown datablock ${object.datablockId}`)
    const name = nameFor(object.name, taken)
    taken.add(name)
    meshes.push({ objectId: object.id, name, positions: placeMesh(datablock.positions, object.transform).positions })
  }
  return meshes
}
