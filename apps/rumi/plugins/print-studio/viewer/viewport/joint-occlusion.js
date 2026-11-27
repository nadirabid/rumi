/** Test joint visibility against the pose's indexed display meshes. */
import * as THREE from 'three'

function meshMass(geometry) {
  const { boundingBox: bounds, index } = geometry
  const positions = geometry.getAttribute('position')
  const origin = bounds.getCenter(new THREE.Vector3())
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cross = new THREE.Vector3()
  const vertices = [a, b, c], center = new THREE.Vector3()
  let volume = 0
  for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
    for (let corner = 0; corner < vertices.length; corner++) {
      const vertex = i + corner
      vertices[corner].fromBufferAttribute(positions, index ? index.getX(vertex) : vertex).sub(origin)
    }
    // Each triangle and the origin form a signed tetrahedron.
    const signed = a.dot(cross.crossVectors(b, c))
    volume += signed
    center.addScaledVector(a.add(b).add(c), signed)
  }
  if (!Number.isFinite(volume) || volume === 0) return null
  center.divideScalar(4 * volume).add(origin)
  return bounds.containsPoint(center) ? { center, volume: Math.abs(volume) / 6 } : null
}

/**
 * Check rear joints against opaque surfaces. A sightline must exit a joint's own
 * part to obscure its pin. Front joints overlay the model.
 * @param {object[]} meshes Display meshes with their physical part ids.
 * @param {object[]} anchors Controls mapped to the parent and child of their first joint.
 * @param {WeakMap} meshMasses Rest geometry estimates shared by both poses.
 * @returns {object} Assembly placement refresh and world-space occlusion query.
 */
export function createJointOcclusion(meshes, anchors, meshMasses) {
  const entries = meshes.map(({ node, part }) => ({
    node, part, geometry: node.geometry, inverse: new THREE.Matrix4(),
    bounds: new THREE.Box3(), material: null, front: null, exit: null,
  }))
  const sightline = new THREE.Ray(), local = new THREE.Ray()
  const point = new THREE.Vector3(), center = new THREE.Vector3(), bounds = new THREE.Box3()
  const mask = (material, side) => ({
    visible: material.visible && (!material.transparent || material.opacity >= 1),
    side: side ?? material.side,
  })
  const sides = (materials, side) => Array.isArray(materials) ? materials.map(material => mask(material, side)) : mask(materials, side)

  function update() {
    bounds.makeEmpty()
    center.set(0, 0, 0)
    let totalMass = 0, complete = true
    for (const entry of entries) {
      const { node, geometry } = entry
      if (!node.visible) continue
      if (geometry.boundingBox === null) geometry.computeBoundingBox()
      entry.inverse.copy(node.matrixWorld).invert()
      entry.bounds.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld)
      bounds.union(entry.bounds)
      if (!meshMasses.has(geometry)) meshMasses.set(geometry, meshMass(geometry))
      const mass = meshMasses.get(geometry)
      if (!mass) { complete = false; continue }
      const weight = mass.volume * Math.abs(node.matrixWorld.determinant())
      totalMass += weight
      center.addScaledVector(point.copy(mass.center).applyMatrix4(node.matrixWorld), weight)
    }
    if (complete && totalMass > 0) center.divideScalar(totalMass)
    else bounds.getCenter(center)
  }

  function hidden(index, camera, direction, target) {
    if (point.subVectors(target, center).dot(direction) < 0) return false
    const anchor = anchors[index]
    sightline.origin.copy(camera)
    const distance = sightline.direction.subVectors(target, camera).length()
    sightline.direction.divideScalar(distance)
    for (const entry of entries) {
      const { node, part } = entry
      const { geometry, material } = node
      const spatial = geometry.userData.rumiSurfaceIndex
      if (!node.visible || !spatial) continue
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
  return { update, hidden }
}
