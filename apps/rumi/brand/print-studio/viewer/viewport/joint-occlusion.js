/** Test joint visibility against the pose's indexed display meshes. */
import * as THREE from 'three'

/**
 * Find opaque surfaces between the camera and a joint. A joint embedded in either
 * of its own parts remains visible until the sightline passes through that part.
 * @param {object[]} meshes Display meshes with their physical part ids.
 * @param {object[]} anchors Controls mapped to the parent and child of their first joint.
 * @returns {Function} Test a control index, camera position and joint position in world space.
 */
export function createJointOcclusion(meshes, anchors) {
  const entries = meshes.map(({ node, part }) => ({
    node, part, geometry: null, matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(),
    bounds: new THREE.Box3(), material: null, front: null, exit: null,
  }))
  const sightline = new THREE.Ray(), local = new THREE.Ray()
  const point = new THREE.Vector3()
  const mask = (material, side) => ({
    visible: material.visible && (!material.transparent || material.opacity >= 1),
    side: side ?? material.side,
  })
  const sides = (materials, side) => Array.isArray(materials) ? materials.map(material => mask(material, side)) : mask(materials, side)

  return (index, camera, target) => {
    const anchor = anchors[index]
    sightline.origin.copy(camera)
    const distance = sightline.direction.subVectors(target, camera).length()
    sightline.direction.divideScalar(distance)
    for (const entry of entries) {
      const { node, part } = entry
      const { geometry, matrixWorld, material } = node
      const spatial = geometry.userData.rumiSurfaceIndex
      if (!node.visible || !spatial) continue
      if (entry.geometry !== geometry || !entry.matrix.equals(matrixWorld)) {
        entry.geometry = geometry
        entry.matrix.copy(matrixWorld)
        entry.inverse.copy(matrixWorld).invert()
        entry.bounds.copy(geometry.boundingBox).applyMatrix4(matrixWorld)
      }
      if (!entry.bounds.containsPoint(camera) &&
          (!sightline.intersectBox(entry.bounds, point) || camera.distanceTo(point) > distance)) continue
      if (entry.material !== material) {
        entry.material = material
        entry.front = sides(material)
        entry.exit = sides(material, THREE.BackSide)
      }
      local.origin.copy(camera).applyMatrix4(entry.inverse)
      local.direction.copy(target).applyMatrix4(entry.inverse).sub(local.origin)
      const limit = local.direction.length()
      local.direction.divideScalar(limit)
      const connected = part === anchor.parent || part === anchor.child
      const tolerance = limit * 1e-7
      if (spatial.pick(local, connected ? entry.exit : entry.front, limit + (connected ? tolerance : -tolerance))) return true
    }
    return false
  }
}
