/** Preview assembly trees without changing the saved meshes used by validation and export. */
import * as THREE from 'three'
import { mechanismMetadata } from '../mechanics.js'
import { normalizeControls } from '../analog/control-spec.js'
import { jointControls } from './joint-controls.js'
import { createJointOcclusion } from './joint-occlusion.js'
import { createSurfaceIndex } from './surfaces.js'

/**
 * Bind GLB physical parts to saved-world joint transforms and declared control widgets.
 * Invalid or unsupported declarations retain visible geometry and return a diagnostic.
 * @param {object} manifest Validated glTF JSON.
 * @param {THREE.Object3D} root Loaded model in millimetres, Z up, before viewer placement.
 * @param {Map<THREE.Object3D, number>} nodeIndices Loader objects mapped to original glTF node indices.
 * @returns {object} Preview factory and controls, or an optional motionIssue without controls.
 */
export function assemblyMotion(manifest, root, nodeIndices) {
  if (!manifest.asset.extras?.rumiAssembly) return manifest.asset.extras?.rumiMotionKeys?.length
    ? { motionIssue: 'Declare the physical assembly and bind each movement to a joint before previewing movement.' } : {}
  return robotMotion(mechanismMetadata(manifest), manifest.nodes, root, nodeIndices, manifest.asset.extras.rumiMotionLabels)
}

/** Bind validated physical links to preview transforms.
 * @param {object} metadata Validated assembly and movement requirements.
 * @param {object[]} nodes Physical mesh identities.
 * @param {THREE.Object3D} root Loaded model in millimetres, Z up.
 * @param {Map<THREE.Object3D, number>} nodeIndices Loaded objects mapped to mesh identities.
 * @param {object} [labels] Optional legacy control labels.
 * @param {object} [presentation] Optional USD widget declarations and joint path map.
 * @returns {object} Preview factory and controls, or a motion diagnostic.
 */
export function robotMotion(metadata, nodes, root, nodeIndices, labels, presentation) {
  const assembly = metadata.assembly
  const unavailable = message => ({ motionIssue: message })
  if (!assembly) return unavailable(metadata.checks.map(check => check.message).join(' '))
  if (!assembly.connections.some(connection => connection.kind !== 'fixed') && !presentation) return {}
  const incoming = new Map(), children = new Map(assembly.parts.map(part => [part.id, []]))
  for (const connection of assembly.connections) {
    if (connection.child === assembly.root || incoming.has(connection.child)) return unavailable('Movement preview requires a tree with one parent per part; closed loops are unsupported.')
    incoming.set(connection.child, connection)
    children.get(connection.parent).push(connection)
  }
  const ordered = [], pending = [assembly.root]
  for (let i = 0; i < pending.length; i++) for (const connection of children.get(pending[i])) {
    ordered.push(connection); pending.push(connection.child)
  }
  const groups = new Map(), bindings = new Map()
  for (const connection of ordered) {
    if (connection.kind === 'fixed') continue
    const id = connection.control === undefined ? `connection:${connection.id}` : `control:${connection.control}`
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(connection)
  }
  if (groups.size > 12) return unavailable('Movement preview supports at most 12 independent controls.')
  const controls = [], parameters = {}
  for (const connections of groups.values()) {
    const first = connections[0]
    const key = metadata.motionRanges.some(item => item.key === first.control)
      && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(first.control)
      && !['constructor', 'prototype', '__proto__'].includes(first.control) ? first.control : `joint${controls.length}`
    if (Object.hasOwn(parameters, key)) return unavailable('Movement control bindings must be unique.')
    if (connections.some(connection => connection.kind !== first.kind)) return unavailable('A shared movement control must use the same units for every joint.')
    const declared = metadata.motionRanges.find(item => item.key === first.control)
    const min = Math.max(...connections.map(connection => connection.range[0]), declared?.range[0] ?? -Infinity)
    const max = Math.min(...connections.map(connection => connection.range[1]), declared?.range[1] ?? Infinity)
    if (min >= max) return unavailable('Shared movement controls require overlapping joint ranges.')
    const origin = declared?.origin ?? 0
    parameters[key] = origin
    const named = Array.isArray(labels) ? labels.find(item => item?.key === first.control)?.label : undefined
    const label = typeof named === 'string' && named.trim() ? named : first.control ?? assembly.parts.find(part => part.id === first.child).mesh
    controls.push({ kind: 'slider', label: label.trim().slice(0, 80), axes: [{ key, min: min + origin, max: max + origin,
      step: Math.min(first.kind === 'revolute' ? 1 : .1, max - min), reset: origin }] })
    for (const connection of connections) bindings.set(connection.id, { key, origin })
  }
  let definitions
  try {
    definitions = presentation ? jointControls(presentation, bindings, controls, parameters) : normalizeControls(controls, parameters)
  }
  catch (error) { return unavailable(error.message) }
  const partsByNode = new Map(assembly.parts.map(part => [nodes.findIndex(node => node.name === part.mesh), part.id]))
  const meshes = []
  root.updateMatrixWorld(true)
  root.traverseVisible(node => {
    if (!node.isMesh) return
    let owner = node, part
    while (owner && part === undefined) { part = partsByNode.get(nodeIndices.get(owner)); owner = owner.parent }
    meshes.push({ node, part, saved: node.matrixWorld.clone(), inverseSaved: node.matrixWorld.clone().invert(), surface: null })
  })
  if (meshes.some(mesh => mesh.part === undefined) || assembly.parts.some(part => !meshes.some(mesh => mesh.part === part.id))) {
    return unavailable('Movement preview could not bind every physical part to its loaded mesh.')
  }
  const anchors = new Map([...groups.values()].map(([joint]) => [bindings.get(joint.id).key, {
    parent: joint.parent, child: joint.child, pivot: new THREE.Vector3(...joint.pivot), kind: joint.kind,
  }]))
  const controlAnchors = definitions.map(control => anchors.get(control.axes[0].key))
  return {
    parameters, motionDefinitions: definitions, poseIdentity: JSON.stringify(assembly),
    motionUnit: key => anchors.get(key)?.kind === 'revolute' ? 'degree' : 'millimeter',
    motionAnchor: (index, target) => target.copy(controlAnchors[index].pivot),
    motionOccluded: createJointOcclusion(meshes, controlAnchors),
    createMotionPreview(parent) {
      const preview = new THREE.Group(), visible = root.visible
      const transforms = new Map(assembly.parts.map(part => [part.id, new THREE.Matrix4()]))
      const steps = ordered.map(connection => {
        const binding = bindings.get(connection.id)
        return { kind: connection.kind, parent: transforms.get(connection.parent), child: transforms.get(connection.child),
          binding, axis: binding && new THREE.Vector3(...connection.axis),
          pivot: binding && new THREE.Vector3(...connection.pivot) }
      })
      const delta = new THREE.Matrix4(), offset = new THREE.Vector3()
      const posed = new Map()
      const copies = new Map(meshes.map(mesh => {
        const node = mesh.node.clone(false)
        node.matrixAutoUpdate = false; preview.add(node)
        posed.set(mesh.node, { node, inverseSaved: mesh.inverseSaved })
        return [node, mesh]
      }))
      return {
        root: preview,
        motionOccluded: createJointOcclusion([...copies].map(([node, mesh]) => ({ node, part: mesh.part })), controlAnchors),
        savedHit(node, worldPoint) {
          const mesh = copies.get(node)
          if (!mesh) return null
          return { node: mesh.node, point: worldPoint.clone().applyMatrix4(node.matrixWorld.clone().invert()).applyMatrix4(mesh.saved) }
        },
        posedHit(source, point) {
          const mesh = posed.get(source)
          return mesh ? { object: mesh.node, point: point.clone().applyMatrix4(mesh.inverseSaved).applyMatrix4(mesh.node.matrixWorld) } : null
        },
        overlayParts(positions) { return bindOverlay(positions, meshes, transforms) },
        motionAnchor(index, target) {
          const anchor = controlAnchors[index]
          return target.copy(anchor.pivot).applyMatrix4(transforms.get(anchor.parent))
        },
        update(values) {
          for (const { kind, parent: parentTransform, child, binding, axis, pivot } of steps) {
            if (kind === 'fixed') child.copy(parentTransform)
            else {
              const value = values[binding.key] - binding.origin
              if (kind === 'prismatic') delta.makeTranslation(offset.copy(axis).multiplyScalar(value))
              else {
                delta.makeRotationAxis(axis, THREE.MathUtils.degToRad(value))
                offset.copy(pivot).applyMatrix4(delta).negate().add(pivot)
                delta.setPosition(offset)
              }
              child.multiplyMatrices(parentTransform, delta)
            }
          }
          for (const [node, mesh] of copies) node.matrix.multiplyMatrices(transforms.get(mesh.part), mesh.saved)
          root.visible = false
          if (preview.parent !== parent) parent.add(preview)
          preview.updateMatrixWorld(true)
        },
        dispose() {
          // Clones borrow geometry and materials from the saved model, whose owner disposes them.
          parent.remove(preview); root.visible = visible
        },
      }
    },
  }
}

// Bind a submitted triangle to the saved surface beneath its centroid. This
// also handles an overlay clipped inside a source triangle.
function bindOverlay(positions, meshes, transforms) {
  const groups = new Map()
  const tolerance = 0.001
  const twoSided = { visible: true, side: THREE.DoubleSide }
  const points = Array.from({ length: 3 }, () => new THREE.Vector3())
  const center = new THREE.Vector3(), normal = new THREE.Vector3(), sample = new THREE.Vector3()
  const ray = new THREE.Ray(), local = new THREE.Ray()
  for (let offset = 0; offset < positions.length; offset += 9) {
    for (let corner = 0; corner < 3; corner++) points[corner].fromArray(positions, offset + corner * 3)
    center.copy(points[0]).add(points[1]).add(points[2]).multiplyScalar(1 / 3)
    THREE.Triangle.getNormal(...points, normal)
    ray.origin.copy(center).addScaledVector(normal, tolerance)
    ray.direction.copy(normal).negate()
    let owner = null, best = tolerance
    for (const mesh of meshes) {
      if (normal.lengthSq() === 0) break
      local.copy(ray).applyMatrix4(mesh.inverseSaved)
      const limit = 2 * sample.copy(center).applyMatrix4(mesh.inverseSaved).distanceTo(local.origin)
      mesh.surface ??= createSurfaceIndex(mesh.node.geometry)
      const hit = mesh.surface.pick(local, twoSided, limit)
      if (!hit) continue
      const distance = center.distanceTo(hit.point.applyMatrix4(mesh.saved))
      if (distance < best) { best = distance; owner = mesh.part }
    }
    if (!groups.has(owner)) groups.set(owner, [])
    for (let i = offset; i < offset + 9; i++) groups.get(owner).push(positions[i])
  }
  return [...groups].map(([part, vertices]) => ({ positions: new Float32Array(vertices), transform: transforms.get(part) }))
}
