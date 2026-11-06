/** Model construction and GPU resource ownership in the renderer. */
import * as THREE from 'three'
import { STL_LIMITS } from '../stl.js'

/**
 * Release resources owned by one design, including resources shared by its parts.
 * @param {THREE.Object3D} root - Detached model.
 * @returns {void}
 */
export function disposeModel(root) {
  const resources = new Set()
  root.traverse((node) => {
    if (node.geometry) resources.add(node.geometry)
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      resources.add(material)
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value)
    }
  })
  for (const resource of resources) resource.dispose()
}

/**
 * Build a static mesh hierarchy and extract the same visible triangles used for measurement.
 * @param {Function} build - Project's synchronous build(THREE) export.
 * @param {object} [parameters] - Numeric values consumed by the model builder.
 * @returns {{root: THREE.Object3D, positions: Float32Array}} Owned model and world-space triangles.
 */
export function buildModel(build, parameters = {}) {
  if (typeof build !== 'function' || build.constructor.name === 'AsyncFunction') throw new Error('Export a synchronous build(THREE) function')
  const root = build(THREE, Object.freeze({ ...parameters }))
  if (root instanceof Promise) {
    root.catch(() => { /* Async designs are rejected; consume their eventual rejection. */ })
    throw new Error('build(THREE) must return a Mesh or Group synchronously')
  }
  if (!root?.isObject3D || root.parent !== null) throw new Error('build(THREE) must return a new Mesh or Group')
  try {
    const values = []
    root.updateMatrixWorld(true)
    root.traverse((node) => {
      if (!(node.isGroup || (node.isMesh && !node.isSkinnedMesh && !node.isInstancedMesh))) {
        throw new Error('Models support static Mesh and Group objects only')
      }
    })
    root.traverseVisible((node) => {
      if (!node.isMesh) return
      const geometry = node.geometry
      const attribute = geometry.getAttribute('position')
      if (!attribute || Object.keys(geometry.morphAttributes).length) throw new Error('Meshes need static position geometry')
      if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) throw new Error('Use complete triangle geometry without draw ranges')
      const count = geometry.index?.count ?? attribute.count
      if (count % 3 !== 0 || values.length + count * 3 > STL_LIMITS.maxTriangles * 9) throw new Error('Models must contain at most 200,000 complete triangles')
      const point = new THREE.Vector3()
      const mirrored = node.matrixWorld.determinant() < 0
      for (let triangle = 0; triangle < count; triangle += 3) {
        for (const corner of mirrored ? [0, 2, 1] : [0, 1, 2]) {
          const index = geometry.index ? geometry.index.getX(triangle + corner) : triangle + corner
          point.fromBufferAttribute(attribute, index).applyMatrix4(node.matrixWorld)
          if (![point.x, point.y, point.z].every(value => Number.isFinite(Math.fround(value)))) throw new Error('Geometry coordinates must be finite')
          values.push(point.x, point.y, point.z)
        }
      }
    })
    if (!values.length) throw new Error('The model contains no visible triangles')
    return { root, positions: new Float32Array(values) }
  } catch (error) {
    disposeModel(root)
    throw error
  }
}
