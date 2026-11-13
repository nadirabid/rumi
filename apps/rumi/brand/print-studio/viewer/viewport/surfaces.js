/** Geometry-local surface boundaries and accelerated picking, prepared once per display copy. */
import * as THREE from 'three'
import { Octree } from 'three/addons/math/Octree.js'

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
  const normals = [], materials = new Int32Array(count)
  const edges = new Map(), vertices = new Map(), faceOf = new Map()
  const tree = new Octree()
  geometry.computeBoundingBox()
  const epsilon = Math.max(geometry.boundingBox.getSize(new THREE.Vector3()).length() * 1e-7, 1e-10)
  for (const group of geometry.groups) {
    materials.fill(group.materialIndex, group.start / 3, (group.start + group.count) / 3)
  }
  const find = face => {
    while (parents[face] !== face) { parents[face] = parents[parents[face]]; face = parents[face] }
    return face
  }
  for (let face = 0; face < count; face++) {
    const points = [0, 1, 2].map(corner => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(face * 3 + corner) : face * 3 + corner))
    const keys = points.map(point => {
      const key = `${Math.round(point.x / epsilon)},${Math.round(point.y / epsilon)},${Math.round(point.z / epsilon)}`
      if (!vertices.has(key)) vertices.set(key, vertices.size)
      return vertices.get(key)
    })
    const triangle = new THREE.Triangle(...points)
    normals.push(triangle.getNormal(new THREE.Vector3()))
    faceOf.set(triangle, face); tree.addTriangle(triangle)
    for (let corner = 0; corner < 3; corner++) {
      const a = keys[(corner + 1) % 3], b = keys[(corner + 2) % 3]
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const entries = edges.get(key) ?? []
      entries.push({ face, corner }); edges.set(key, entries)
    }
  }
  const threshold = Math.cos(THREE.MathUtils.degToRad(35))
  for (const entries of edges.values()) {
    const [a, b] = entries
    const connected = entries.length === 2 && materials[a.face] === materials[b.face]
      && normals[a.face].dot(normals[b.face]) > threshold
    if (connected) parents[find(b.face)] = find(a.face)
    else for (const { face, corner } of entries) {
      for (let vertex = 0; vertex < 3; vertex++) boundary[face * 9 + vertex * 3 + corner] = 1
    }
  }
  for (let face = 0; face < count; face++) ids.fill(find(face) + 1, face * 3, face * 3 + 3)
  // Keep extrema inside child boxes despite floating-point subdivision roundoff.
  tree.bounds.expandByScalar(epsilon * 2)
  // Bound subdivision by input size: a full tree has at most eight leaf cells
  // per triangle. Thin or degenerate faces cannot force sixteen levels of copies.
  // split's starting level consumes the public Octree subdivision budget.
  const depth = Math.max(1, Math.ceil(Math.log2(count) / 3))
  tree.calcBox()
  tree.split(Math.max(0, tree.maxLevel - depth + 1))
  edges.clear(); vertices.clear(); normals.length = 0
  const candidates = [], point = new THREE.Vector3()
  return {
    ids, boundary, count,
    surface(face) { return ids[face * 3] },
    pick(ray, material) {
      candidates.length = 0
      tree.getRayTriangles(ray, candidates)
      let nearest = null, distance = Infinity
      for (const triangle of candidates) {
        const faceIndex = faceOf.get(triangle)
        const faceMaterial = Array.isArray(material) ? material[materials[faceIndex]] : material
        if (!faceMaterial?.visible) continue
        const { a, b, c } = triangle
        const hit = faceMaterial.side === THREE.BackSide
          ? ray.intersectTriangle(c, b, a, true, point)
          : ray.intersectTriangle(a, b, c, faceMaterial.side !== THREE.DoubleSide, point)
        if (hit && ray.origin.distanceToSquared(hit) < distance) {
          distance = ray.origin.distanceToSquared(hit)
          nearest = { faceIndex, point: hit.clone() }
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
