/** Load Blender exports into the viewer's millimetre, Z-up coordinate system. */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { validateGlb } from '../glb.js'
import { buildModel, disposeModel } from './model.js'
import { assemblyMotion } from './assembly-motion.js'

/**
 * Parse an embedded static GLB, retaining part names, normals and materials.
 * @param {ArrayBuffer} buffer - Standard glTF metres, Y-up bytes.
 * @returns {Promise<ReturnType<typeof buildModel> & ReturnType<typeof assemblyMotion>>} Owned model, saved triangles and optional movement preview.
 */
export async function parseGlbModel(buffer) {
  const manifest = validateGlb(new Uint8Array(buffer))
  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  const root = new THREE.Group()
  root.name = gltf.scene.name || 'Model'
  root.userData.rumiCoordinateFrame = true
  root.rotation.x = Math.PI / 2
  root.scale.setScalar(1000)
  for (const child of [...gltf.scene.children]) root.add(child)
  // Blender collections/empties can be plain Object3D nodes; normalize grouping only.
  root.traverse(node => {
    if (node.type === 'Object3D') node.isGroup = true
  })
  try {
    const model = buildModel(() => root)
    const nodeIndices = new Map()
    root.traverse(node => {
      const index = gltf.parser.associations.get(node)?.nodes
      if (index !== undefined) nodeIndices.set(node, index)
    })
    return { ...model, ...assemblyMotion(manifest, root, nodeIndices) }
  } finally {
    for (const scene of gltf.scenes) if (scene !== gltf.scene) disposeModel(scene)
  }
}

/**
 * Fetch an immutable viewer snapshot and parse it.
 * @param {string} url - Host-published GLB URL.
 * @returns {Promise<ReturnType<typeof buildModel> & ReturnType<typeof assemblyMotion>>} Owned model, disposed by the viewport even when superseded.
 */
export async function loadGlbModel(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GLB load failed (${response.status})`)
  return parseGlbModel(await response.arrayBuffer())
}
