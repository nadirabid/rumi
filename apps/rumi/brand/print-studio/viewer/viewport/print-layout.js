/** Print-only transforms borrow original GPU resources and never modify the assembly. */
import { manufacturingChecks } from '../manufacturing.js'
import * as THREE from 'three'
import { encodeStl } from '../stl.js'
import { parsePrintLayout } from '../print-layout/state.js'

function rotationMatrix(rotation) {
  return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation.map(THREE.MathUtils.degToRad), 'XYZ'))
}

/** Collect printable groups in the saved assembly pose, requiring separate printing for moving parts.
 * @param {object} design Loaded USD model with validated assembly metadata.
 * @returns {object[]} Groups with borrowed meshes, saved matrices and millimetre bounds.
 */
export function printParts(design) {
  const meshes = []
  design.root.updateWorldMatrix(true, true)
  design.root.traverseVisible(node => { if (node.isMesh) meshes.push(node) })
  const assembly = design.robot?.assembly
  if (assembly && manufacturingChecks(assembly).length) throw new Error('layoutSeparateRequired')
  if (!assembly && meshes.length > 1) throw new Error('Declare how the parts are manufactured before arranging them')
  const groups = new Map()
  for (const node of meshes) {
    const id = assembly?.manufacturing.mode === 'print-in-place' ? 'assembly' : node.name
    if (!groups.has(id)) groups.set(id, { id, name: id === 'assembly' ? null : node.name, meshes: [], bounds: new THREE.Box3() })
    const group = groups.get(id), matrix = node.matrixWorld.clone()
    group.meshes.push({ node, matrix })
    const position = node.geometry.getAttribute('position'), point = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) group.bounds.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(matrix))
  }
  return [...groups.values()]
}

function dimensions(part, rotation) {
  const bounds = part.bounds.clone().applyMatrix4(rotationMatrix(rotation))
  return { bounds, size: bounds.getSize(new THREE.Vector3()), center: bounds.getCenter(new THREE.Vector3()) }
}

/** Pack bounding rectangles onto additional plates, preserving scale and part grouping.
 * @param {object[]} parts Printable groups.
 * @param {object} options Explicit identity, volume and part/edge spacing in millimetres.
 * @returns {object} Layout; oversized parts remain visible and fail layoutIssues.
 */
export function arrangePrintParts(parts, { identity, volume, gap }) {
  const rotations = [[0, 0, 0], [90, 0, 0], [0, 90, 0], [0, 0, 90], [90, 0, 90], [0, 90, 90]]
  const oriented = parts.map(part => {
    const choices = rotations.map(rotation => ({ rotation, ...dimensions(part, rotation) }))
    const fits = choices.filter(item => item.size.x + 2 * gap <= volume.x && item.size.y + 2 * gap <= volume.y && item.size.z <= volume.z)
    const choice = (fits.length ? fits : choices).sort((a, b) => a.size.z - b.size.z || a.size.y - b.size.y)[0]
    return { part, ...choice }
  }).sort((a, b) => b.size.y - a.size.y || b.size.x - a.size.x || a.part.id.localeCompare(b.part.id))
  const placements = [], plates = []
  for (const { part, rotation, size } of oriented) {
    let index = plates.findIndex(plate => (plate.x + size.x + gap <= volume.x && plate.y + size.y + gap <= volume.y)
      || (gap + size.x + gap <= volume.x && plate.y + plate.row + gap + size.y + gap <= volume.y))
    if (index === -1) { index = plates.length; plates.push({ x: gap, y: gap, row: 0 }) }
    const plate = plates[index]
    if (plate.x + size.x + gap > volume.x && plate.row > 0) { plate.x = gap; plate.y += plate.row + gap; plate.row = 0 }
    placements.push({ id: part.id, plate: index, rotation: [...rotation], position: [plate.x + size.x / 2 - volume.x / 2, plate.y + size.y / 2 - volume.y / 2] })
    plate.x += size.x + gap; plate.row = Math.max(plate.row, size.y)
  }
  return { version: 1, identity, volume: { ...volume }, gap, parts: placements }
}

/** Check conservative plate bounds and pairwise spacing; does not certify supports or slicing.
 * @param {object[]} parts Printable groups.
 * @param {object} layout Validated placement.
 * @returns {string[]} Stable issue codes.
 */
export function layoutIssues(parts, layout) {
  const issues = new Set(), rectangles = []
  for (const placement of layout.parts) {
    const part = parts.find(part => part.id === placement.id)
    if (!part) { issues.add('layoutChanged'); continue }
    const { size } = dimensions(part, placement.rotation), [x, y] = placement.position
    if (Math.abs(x) + size.x / 2 + layout.gap > layout.volume.x / 2 + 1e-5
      || Math.abs(y) + size.y / 2 + layout.gap > layout.volume.y / 2 + 1e-5 || size.z > layout.volume.z + 1e-5) issues.add('layoutOutside')
    for (const other of rectangles) if (other.plate === placement.plate
      && Math.abs(x - other.x) < (size.x + other.size.x) / 2 + layout.gap - 1e-5
      && Math.abs(y - other.y) < (size.y + other.size.y) / 2 + layout.gap - 1e-5) issues.add('layoutOverlap')
    rectangles.push({ x, y, size, plate: placement.plate })
  }
  if (parts.length !== layout.parts.length) issues.add('layoutChanged')
  return [...issues]
}

function placedMatrix(part, placement) {
  const rotation = rotationMatrix(placement.rotation), { bounds, center } = dimensions(part, placement.rotation)
  return new THREE.Matrix4().makeTranslation(placement.position[0] - center.x, placement.position[1] - center.y, -bounds.min.z).multiply(rotation)
}

/** Create a reversible print preview sharing original geometry/materials.
 * @param {object[]} parts Printable groups.
 * @param {THREE.Scene} scene Destination, in millimetres and Z up.
 * @param {THREE.Color} [selectionColor] Outline color; omitted by geometry-only consumers.
 * @returns {object} Placement, STL export, picking roots and non-owning cleanup.
 */
export function createPrintPreview(parts, scene, selectionColor) {
  const root = new THREE.Group(), copies = new Map()
  for (const part of parts) {
    const group = new THREE.Group(); group.name = part.id; group.userData.printPart = part.id
    group.matrixAutoUpdate = false
    for (const { node, matrix } of part.meshes) {
      const copy = new THREE.Mesh(node.geometry, node.material)
      copy.matrixAutoUpdate = false; copy.matrix.copy(matrix); group.add(copy)
    }
    root.add(group); copies.set(part.id, group)
  }
  scene.add(root)
  const selection = selectionColor ? new THREE.Box3Helper(new THREE.Box3(), selectionColor) : null
  if (selection) { selection.visible = false; scene.add(selection) }
  let layout = null, plate = 0
  return {
    root,
    apply(value, selectedPlate, selectedPart) {
      const next = parsePrintLayout(value)
      if (next.parts.length !== parts.length || next.parts.some(item => !copies.has(item.id))) throw new Error('Print layout does not match the model')
      layout = next; plate = selectedPlate
      for (const placement of layout.parts) {
        const group = copies.get(placement.id)
        group.visible = placement.plate === plate
        group.matrix.copy(placedMatrix(parts.find(part => part.id === placement.id), placement))
      }
      root.updateMatrixWorld(true)
      if (selection) {
        const chosen = layout.parts.find(part => part.id === selectedPart && part.plate === plate)
        selection.visible = Boolean(chosen)
        if (chosen) {
          const part = parts.find(part => part.id === chosen.id)
          selection.box.copy(part.bounds).applyMatrix4(placedMatrix(part, chosen))
        }
      }
    },
    exportPlate() {
      if (!layout || layoutIssues(parts, layout).length) throw new Error('Resolve print layout issues before export')
      const selected = layout.parts.filter(part => part.plate === plate)
      if (!selected.length) throw new Error('The selected plate is empty')
      const values = [], point = new THREE.Vector3()
      for (const placement of selected) {
        const part = parts.find(part => part.id === placement.id), transform = placedMatrix(part, placement)
        for (const { node, matrix } of part.meshes) {
          const world = transform.clone().multiply(matrix), geometry = node.geometry, position = geometry.getAttribute('position')
          const count = geometry.index?.count ?? position.count, mirrored = world.determinant() < 0
          for (let triangle = 0; triangle < count; triangle += 3) for (const corner of mirrored ? [0, 2, 1] : [0, 1, 2]) {
            const index = geometry.index ? geometry.index.getX(triangle + corner) : triangle + corner
            point.fromBufferAttribute(position, index).applyMatrix4(world)
            values.push(point.x, point.y, point.z)
          }
        }
      }
      return encodeStl(values)
    },
    dispose() { scene.remove(root); if (selection) { scene.remove(selection); selection.geometry.dispose(); selection.material.dispose() } },
  }
}
