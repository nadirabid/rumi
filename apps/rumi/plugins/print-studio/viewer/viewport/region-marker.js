/** Project a representative point from a highlighted surface into the overlay layer. */
import * as THREE from 'three'
import { createSurfaceIndex } from './surfaces.js'

/**
 * Map a cursor ray to the named overlay where it coincides with the visible model surface.
 * @param {THREE.Object3D} overlay Named surface mesh or posed group of surface meshes.
 * @returns {Function} The mesh and local hit point, or null for a miss or an obscured region.
 */
export function createRegionPicker(overlay) {
  const entries = []
  overlay.traverse(node => { if (node.isMesh) entries.push({ mesh: node, index: createSurfaceIndex(node.geometry) }) })
  const ray = new THREE.Ray(), inverse = new THREE.Matrix4(), worldPoint = new THREE.Vector3()
  return (surface, worldRay) => {
    if (!surface || !overlay.visible) return null
    overlay.updateWorldMatrix(true, true)
    for (const { mesh, index } of entries) {
      ray.copy(worldRay).applyMatrix4(inverse.copy(mesh.matrixWorld).invert())
      const hit = index.pick(ray, mesh.material)
      // The overlay uses model-local millimetres and may have been clipped and exported as Float32.
      if (hit && worldPoint.copy(hit.point).applyMatrix4(mesh.matrixWorld).distanceToSquared(surface.point) <= 0.02 ** 2) {
        return { mesh, point: hit.point }
      }
    }
    return null
  }
}

/**
 * Locate a label on a triangle near the overlay's centre.
 * @param {THREE.Mesh} mesh Highlight mesh with non-indexed triangles.
 * @returns {THREE.Vector3} Anchor in the highlight mesh's local coordinates.
 */
export function regionAnchor(mesh) {
  const { geometry } = mesh
  geometry.computeBoundingBox()
  const middle = geometry.boundingBox.getCenter(new THREE.Vector3())
  const positions = geometry.getAttribute('position')
  const anchor = new THREE.Vector3(), centroid = new THREE.Vector3(), corner = new THREE.Vector3()
  let nearest = Infinity
  for (let i = 0; i < positions.count; i += 3) {
    centroid.fromBufferAttribute(positions, i)
      .add(corner.fromBufferAttribute(positions, i + 1))
      .add(corner.fromBufferAttribute(positions, i + 2)).multiplyScalar(1 / 3)
    const distance = centroid.distanceToSquared(middle)
    if (distance < nearest) { nearest = distance; anchor.copy(centroid) }
  }
  return anchor
}
