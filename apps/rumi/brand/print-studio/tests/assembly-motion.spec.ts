/** Real GLB loading, hierarchy transforms, and borrowed resource ownership for movement previews. */
import * as THREE from 'three'
import { expect, it, vi } from 'vitest'
import { parseGlbModel } from '../viewer/viewport/glb.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { assembly, assemblyGlb } from './fixtures/assembly-glb.js'

it('moves a hinge, nested slider and fixed descendant in saved-world units without changing printable geometry', async () => {
  const model = await parseGlbModel(assemblyGlb().buffer)
  const parent = new THREE.Group()
  parent.position.set(100, 200, 300); parent.rotation.z = Math.PI / 2; parent.scale.setScalar(2)
  parent.add(model.root)
  const saved = model.positions.slice(), original = model.root.clone(true)
  const preview = model.createMotionPreview(parent)
  try {
    expect(model.motionDefinitions.map(control => control.label)).toEqual(['Right door', 'Slide'])
    preview.update({ joint0: 90, joint1: 5 })
    parent.updateMatrixWorld(true)
    const shown = parent.children.find(child => child !== model.root)
    const positions = new Map()
    shown.traverse((node) => {
      if (node.isMesh) {
        positions.set(node.name, node.getWorldPosition(new THREE.Vector3()).applyMatrix4(parent.matrixWorld.clone().invert()).toArray())
      }
    })
    for (const [name, expected] of [['Body', [0, 0, 0]], ['DoorRight', [10, 20, 30]], ['Slide', [10, 27, 30]], ['Cap', [10, 28, 30]]]) {
      positions.get(name).forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5))
    }
    expect(model.root.visible).toBe(false)
    expect(model.positions).toEqual(saved)
    expect(model.root.getObjectByName('Slide').matrix).toEqual(original.getObjectByName('Slide').matrix)
    const dispose = vi.spyOn(model.root.getObjectByName('Slide').geometry, 'dispose')
    preview.dispose()
    expect(dispose).not.toHaveBeenCalled()
    expect(model.root.visible).toBe(true)
    expect(parent.children).toEqual([model.root])
    dispose.mockRestore()
  } finally { preview.dispose(); disposeModel(model.root) }
})

it('keeps invalid and closed-loop assemblies visible with a movement diagnostic', async () => {
  for (const invalid of [
    { ...assembly, parts: assembly.parts.slice(1) },
    { ...assembly, connections: [...assembly.connections, { id: 'loop', parent: 'cap', child: 'door', kind: 'fixed' }] },
  ]) {
    const model = await parseGlbModel(assemblyGlb({ asset: { version: '2.0', extras: { rumiAssembly: invalid } } }).buffer)
    try {
      expect(model.positions.length).toBeGreaterThan(0)
      expect(model.motionIssue).toBeTruthy()
      expect(model.motionDefinitions).toBeUndefined()
    } finally { disposeModel(model.root) }
  }
})

it('uses absolute control origins and binds multiple primitive meshes by their original glTF node', async () => {
  const model = await parseGlbModel(assemblyGlb({
    asset: { version: '2.0', extras: { rumiAssembly: assembly,
      rumiMotionKeys: ['Right door'], rumiMotionRanges: [{ key: 'Right door', range: [-30, 60], origin: 30 }] } },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 } }] }],
  }).buffer)
  const parent = new THREE.Group(); parent.add(model.root)
  try {
    expect(model.motionDefinitions[0].axes[0]).toEqual({ key: 'joint0', min: 0, max: 90, step: 1, reset: 30 })
    const preview = model.createMotionPreview(parent)
    preview.update({ joint0: 30, joint1: 0 })
    expect(parent.children[1].children).toHaveLength(8)
    const savedPoints = [], posedPoints = []
    model.root.updateMatrixWorld(true); parent.children[1].updateMatrixWorld(true)
    model.root.traverse((node) => { if (node.isMesh) savedPoints.push(node.matrixWorld.elements) })
    parent.children[1].traverse((node) => { if (node.isMesh) posedPoints.push(node.matrixWorld.elements) })
    expect(posedPoints).toEqual(savedPoints)
    preview.dispose()
  } finally { disposeModel(model.root) }
})

it('keeps geometry visible when a saved control origin exceeds the supported numeric range', async () => {
  const model = await parseGlbModel(assemblyGlb({
    asset: { version: '2.0', extras: { rumiAssembly: assembly,
      rumiMotionRanges: [{ key: 'Right door', range: [-30, 60], origin: 1000001 }] } },
  }).buffer)
  try {
    expect(model.motionIssue).toContain('Invalid parameter')
    expect(model.motionDefinitions).toBeUndefined()
    expect(model.positions.length).toBeGreaterThan(0)
  } finally { disposeModel(model.root) }
})
