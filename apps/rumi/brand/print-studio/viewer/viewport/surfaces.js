/** Geometry-local surface boundaries and compact face-block picking, prepared once per display copy. */
import * as THREE from 'three'

/**
 * Partition triangles at open edges, material seams and creases of at least 35 degrees.
 * @param {THREE.BufferGeometry} geometry - Static complete triangle geometry.
 * @returns {object} Surface ids, boundary attributes and an accelerated local-space picker.
 */
export function createSurfaceIndex(geometry) {
  const position = geometry.getAttribute('position'), index = geometry.index
  const count = (index?.count ?? position.count) / 3
  const parents = Int32Array.from({ length: count }, (_, i) => i)
  const ids = new Float32Array(count * 3), boundary = new Float32Array(count * 9)
  const normals = new Float64Array(count * 3), materials = new Int32Array(count)
  const edges = new Map(), vertices = new Map()
  const siblings = new Int32Array(count * 3).fill(-1)
  // Equal-sized blocks bound storage independently of overlapping or degenerate triangles.
  const blockSize = Math.max(1, Math.ceil(Math.sqrt(count)))
  const bounds = new Float64Array(Math.ceil(count / blockSize) * 6)
  for (let offset = 0; offset < bounds.length; offset += 6) {
    bounds.fill(Infinity, offset, offset + 3)
    bounds.fill(-Infinity, offset + 3, offset + 6)
  }
  geometry.computeBoundingBox()
  const epsilon = Math.max(geometry.boundingBox.getSize(new THREE.Vector3()).length() * 1e-7, 1e-10)
  for (const group of geometry.groups) {
    materials.fill(group.materialIndex, group.start / 3, (group.start + group.count) / 3)
  }
  const find = face => {
    while (parents[face] !== face) { parents[face] = parents[parents[face]]; face = parents[face] }
    return face
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3()
  const points = [a, b, c], keys = new Int32Array(3)
  const vertexStride = position.count
  for (let face = 0; face < count; face++) {
    const offset = Math.floor(face / blockSize) * 6
    for (let corner = 0; corner < 3; corner++) {
      const point = points[corner].fromBufferAttribute(position, index ? index.getX(face * 3 + corner) : face * 3 + corner)
      const key = `${Math.round(point.x / epsilon)},${Math.round(point.y / epsilon)},${Math.round(point.z / epsilon)}`
      if (!vertices.has(key)) vertices.set(key, vertices.size)
      keys[corner] = vertices.get(key)
      bounds[offset] = Math.min(bounds[offset], point.x)
      bounds[offset + 1] = Math.min(bounds[offset + 1], point.y)
      bounds[offset + 2] = Math.min(bounds[offset + 2], point.z)
      bounds[offset + 3] = Math.max(bounds[offset + 3], point.x)
      bounds[offset + 4] = Math.max(bounds[offset + 4], point.y)
      bounds[offset + 5] = Math.max(bounds[offset + 5], point.z)
    }
    THREE.Triangle.getNormal(a, b, c, normal).toArray(normals, face * 3)
    for (let corner = 0; corner < 3; corner++) {
      const a = keys[(corner + 1) % 3], b = keys[(corner + 2) % 3]
      // Vertex ids fit the viewer's 200,000-triangle limit, so this pair is an exact integer.
      const key = Math.min(a, b) * vertexStride + Math.max(a, b)
      const slot = face * 3 + corner
      siblings[slot] = edges.get(key) ?? -1
      edges.set(key, slot)
    }
  }
  const threshold = Math.cos(THREE.MathUtils.degToRad(35))
  for (const last of edges.values()) {
    const first = siblings[last]
    const a = Math.floor(first / 3), b = Math.floor(last / 3)
    const connected = first !== -1 && siblings[first] === -1 && materials[a] === materials[b]
      && normals[a * 3] * normals[b * 3] + normals[a * 3 + 1] * normals[b * 3 + 1]
        + normals[a * 3 + 2] * normals[b * 3 + 2] > threshold
    if (connected) parents[find(b)] = find(a)
    else for (let slot = last; slot !== -1; slot = siblings[slot]) {
      const face = Math.floor(slot / 3), corner = slot % 3
      for (let vertex = 0; vertex < 3; vertex++) boundary[face * 9 + vertex * 3 + corner] = 1
    }
  }
  for (let face = 0; face < count; face++) ids.fill(find(face) + 1, face * 3, face * 3 + 3)
  edges.clear(); vertices.clear()
  const box = new THREE.Box3(), point = new THREE.Vector3()
  return {
    ids, boundary, count,
    surface(face) { return ids[face * 3] },
    pick(ray, material) {
      let nearest = null, distance = Infinity
      for (let block = 0; block * 6 < bounds.length; block++) {
        box.min.fromArray(bounds, block * 6)
        box.max.fromArray(bounds, block * 6 + 3)
        if (!ray.intersectsBox(box)) continue
        const end = Math.min(count, (block + 1) * blockSize)
        for (let faceIndex = block * blockSize; faceIndex < end; faceIndex++) {
          const faceMaterial = Array.isArray(material) ? material[materials[faceIndex]] : material
          if (!faceMaterial?.visible) continue
          for (let corner = 0; corner < 3; corner++) {
            points[corner].fromBufferAttribute(position, index ? index.getX(faceIndex * 3 + corner) : faceIndex * 3 + corner)
          }
          const hit = faceMaterial.side === THREE.BackSide
            ? ray.intersectTriangle(c, b, a, true, point)
            : ray.intersectTriangle(a, b, c, faceMaterial.side !== THREE.DoubleSide, point)
          if (hit && ray.origin.distanceToSquared(hit) < distance) {
            distance = ray.origin.distanceToSquared(hit)
            nearest = { faceIndex, point: hit.clone() }
          }
        }
      }
      return nearest
    },
  }
}

/**
 * Describe a mesh by its hierarchy relative to the displayed design root.
 * @param {THREE.Object3D} node - Part to identify.
 * @param {THREE.Object3D} root - Included root of the displayed model.
 * @returns {string[]} Stable path for one source revision.
 */
export function partPath(node, root) {
  const path = []
  while (node) {
    path.unshift(node.name || `child[${node.parent ? node.parent.children.indexOf(node) : 0}]`)
    if (node === root) break
    node = node.parent
  }
  return path
}
