/** Preview assembly trees without changing the saved meshes used by validation and export. */
import * as THREE from 'three'
import { mechanismMetadata } from '../mechanics.js'
import { normalizeControls } from '../analog/control-spec.js'

/**
 * Bind GLB physical parts to saved-world joint transforms and existing slider declarations.
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
 * @returns {object} Preview factory and controls, or a motion diagnostic.
 */
export function robotMotion(metadata, nodes, root, nodeIndices, labels) {
  const assembly = metadata.assembly
  const unavailable = message => ({ motionIssue: message })
  if (!assembly) return unavailable(metadata.checks.map(check => check.message).join(' '))
  if (!assembly.connections.some(connection => connection.kind !== 'fixed')) return {}
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
  try { normalizeControls(controls, parameters) }
  catch (error) { return unavailable(error.message) }
  const partsByNode = new Map(assembly.parts.map(part => [nodes.findIndex(node => node.name === part.mesh), part.id]))
  const meshes = []
  root.updateMatrixWorld(true)
  root.traverseVisible(node => {
    if (!node.isMesh) return
    let owner = node, part
    while (owner && part === undefined) { part = partsByNode.get(nodeIndices.get(owner)); owner = owner.parent }
    meshes.push({ node, part, saved: node.matrixWorld.clone() })
  })
  if (meshes.some(mesh => mesh.part === undefined) || assembly.parts.some(part => !meshes.some(mesh => mesh.part === part.id))) {
    return unavailable('Movement preview could not bind every physical part to its loaded mesh.')
  }
  return {
    parameters, motionDefinitions: controls, poseIdentity: JSON.stringify(assembly),
    createMotionPreview(parent) {
      const preview = new THREE.Group(), visible = root.visible
      const copies = meshes.map(mesh => {
        const node = mesh.node.clone(false)
        node.matrixAutoUpdate = false; preview.add(node)
        return { ...mesh, node }
      })
      return {
        root: preview,
        update(values) {
          const transforms = new Map([[assembly.root, new THREE.Matrix4()]])
          for (const connection of ordered) {
            const delta = new THREE.Matrix4()
            if (connection.kind !== 'fixed') {
              const binding = bindings.get(connection.id), value = values[binding.key] - binding.origin
              const axis = new THREE.Vector3(...connection.axis)
              if (connection.kind === 'prismatic') delta.makeTranslation(...axis.multiplyScalar(value).toArray())
              else {
                const pivot = new THREE.Vector3(...connection.pivot)
                delta.makeTranslation(...pivot.toArray())
                  .multiply(new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(value)))
                  .multiply(new THREE.Matrix4().makeTranslation(...pivot.negate().toArray()))
              }
            }
            transforms.set(connection.child, transforms.get(connection.parent).clone().multiply(delta))
          }
          for (const mesh of copies) mesh.node.matrix.copy(transforms.get(mesh.part)).multiply(mesh.saved)
          root.visible = false; parent.add(preview); preview.updateMatrixWorld(true)
        },
        dispose() {
          // Clones borrow geometry and materials from the saved model, whose owner disposes them.
          parent.remove(preview); root.visible = visible
        },
      }
    },
  }
}
