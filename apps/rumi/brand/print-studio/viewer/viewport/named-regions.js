/** The same saved model features drive hit testing, highlights, and mesh export. */
import * as THREE from 'three'
import { encodeStlBase64, STL_LIMITS } from '../stl.js'
import { modelLocalPartMatrix, modelPartPath } from './cursor-geometry.js'
import { createSurfaceIndex } from './surfaces.js'

const MIN_DETAIL_PIXELS = 36
const MIN_NESTED_ZOOM_RATIO = 1.25

function vector(point) { return new THREE.Vector3(...point) }
function box(bounds) { return new THREE.Box3(vector(bounds.slice(0, 3)), vector(bounds.slice(3))) }

function compileSurface(location, parts, indexes) {
  const selectors = new Map()
  for (const part of location.parts) {
    const node = parts.get(JSON.stringify(part.partPath))
    if (!node) return null
    const geometry = node.geometry
    const count = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
    const faces = new Uint8Array(count)
    if (!part.surfaceIds && !part.faceRanges) faces.fill(1)
    for (const [start, end] of part.faceRanges ?? []) {
      if (end > count) return null
      faces.fill(1, start, end)
    }
    if (part.surfaceIds) {
      let index = geometry.userData.rumiSurfaceIndex ?? indexes.get(geometry)
      if (!index) { index = createSurfaceIndex(geometry); indexes.set(geometry, index) }
      const remaining = new Set(part.surfaceIds)
      const ids = new Set(part.surfaceIds)
      for (let face = 0; face < count; face++) {
        const id = index.surface(face)
        if (!ids.has(id)) continue
        remaining.delete(id)
        faces[face] = 1
      }
      if (remaining.size) return null
    }
    if (!faces.some(Boolean)) return null
    selectors.set(node, faces)
  }
  return selectors
}

function compileRegion(region, parts, indexes) {
  const { location } = region
  switch (location.kind) {
    case 'surface': {
      const selectors = compileSurface(location, parts, indexes)
      return selectors && { region, selectors, children: [] }
    }
    case 'volume': return { region, boxes: location.boxes.map(box) }
    case 'curve': {
      const points = location.points.map(vector)
      if (location.closed) points.push(points[0])
      return { region, points }
    }
    case 'point': return { region, point: vector(location.point) }
    default: return null
  }
}

function detailExtents(entry, parent) {
  const extents = new Map()
  const bounds = new THREE.Box3()
  const point = new THREE.Vector3()
  for (const [node, faces] of entry.selectors) {
    const parentFaces = parent.selectors.get(node)
    if (!parentFaces) return null
    const { index } = node.geometry
    const positions = node.geometry.getAttribute('position')
    bounds.makeEmpty()
    for (let face = 0; face < faces.length; face++) {
      if (!faces[face]) continue
      if (!parentFaces[face]) return null
      for (let corner = face * 3; corner < face * 3 + 3; corner++) {
        point.fromBufferAttribute(positions, index ? index.getX(corner) : corner)
        bounds.expandByPoint(point)
      }
    }
    extents.set(node, bounds.getSize(new THREE.Vector3()))
  }
  return extents
}

function matchingDetail(entry, savedNode, face, matrix, minimumExtent, parentBreadth = Infinity) {
  const elements = matrix.elements
  for (const child of entry.children) {
    if (!child.selectors.get(savedNode)?.[face]) continue
    const { x, y, z } = child.extents.get(savedNode)
    const width = x * Math.hypot(elements[0], elements[1], elements[2])
    const height = y * Math.hypot(elements[4], elements[5], elements[6])
    const depth = z * Math.hypot(elements[8], elements[9], elements[10])
    // A long edge still needs enough width to become a separate target.
    const breadth = Math.max(Math.min(width, height), Math.min(width, depth), Math.min(height, depth))
    // Nested rings can span the same diameter. Keep a zoom interval for the parent.
    const revealBreadth = Math.min(breadth, parentBreadth / MIN_NESTED_ZOOM_RATIO)
    if (revealBreadth >= minimumExtent) return matchingDetail(child, savedNode, face, matrix, minimumExtent, revealBreadth)
  }
  return entry
}

/**
 * Resolve semantic geometry for the loaded USD. A child must select only its parent's triangles.
 * @param {THREE.Object3D} root Saved USD hierarchy.
 * @param {THREE.Object3D} placement Parent placement group.
 * @param {object[]} regions Ordered, validated feature definitions.
 * @returns {object} Look up geometry directly or pick the visible level of detail.
 */
export function createNamedRegionIndex(root, placement, regions) {
  const parts = new Map(), indexes = new WeakMap()
  root.traverse(node => {
    if (!node.isMesh) return
    const path = JSON.stringify(modelPartPath(node, placement))
    parts.set(path, parts.has(path) ? null : node)
  })
  const entries = regions.map(region => compileRegion(region, parts, indexes)).filter(Boolean)
  const compiled = new Map(entries.map(entry => [entry.region.id, entry]))
  const byId = new Map()
  function resolve(entry) {
    if (!entry) return null
    const { id, parentId } = entry.region
    if (byId.has(id)) return byId.get(id)
    const parent = parentId ? resolve(compiled.get(parentId)) : null
    if (parentId) {
      const extents = parent && detailExtents(entry, parent)
      if (!extents) { byId.set(id, null); return null }
      entry.extents = extents
    }
    byId.set(id, entry)
    return entry
  }
  const roots = []
  for (const candidate of entries) {
    const entry = resolve(candidate)
    if (!entry) continue
    const { parentId } = entry.region
    if (parentId) byId.get(parentId).children.push(entry)
    else roots.push(entry)
  }
  const ray = new THREE.Ray(), inverse = new THREE.Matrix4()
  const rayPoint = new THREE.Vector3(), curvePoint = new THREE.Vector3()
  return {
    get(id) { return byId.get(id) ?? undefined },
    pick(surface, savedNode, worldRay, pixelScale) {
      placement.updateWorldMatrix(true, false)
      ray.copy(worldRay).applyMatrix4(inverse.copy(placement.matrixWorld).invert())
      const modelHit = surface && surface.point.clone().applyMatrix4(inverse)
      const modelDistance = modelHit ? ray.origin.distanceTo(modelHit) : Infinity
      for (const entry of roots) {
        if (entry.selectors) {
          if (!surface || !entry.selectors.get(savedNode)?.[surface.faceIndex]) continue
          const named = entry.children.length
            ? matchingDetail(entry, savedNode, surface.faceIndex, surface.object.matrixWorld,
              MIN_DETAIL_PIXELS * pixelScale * worldRay.origin.distanceTo(surface.point))
            : entry
          return { ...surface, named }
        }
        let picked = null, nearest = Infinity
        const accept = (point, distance) => {
          if (distance > modelDistance + distance * pixelScale * 3 || distance >= nearest) return
          picked = point.clone()
          nearest = distance
        }
        if (entry.boxes) {
          for (const bounds of entry.boxes) {
            if (modelHit && bounds.containsPoint(modelHit)) accept(modelHit, modelDistance)
            else if (ray.intersectBox(bounds, rayPoint)) accept(rayPoint, ray.origin.distanceTo(rayPoint))
          }
        } else if (entry.points) {
          for (let i = 1; i < entry.points.length; i++) {
            const distanceSquared = ray.distanceSqToSegment(entry.points[i - 1], entry.points[i], rayPoint, curvePoint)
            const depth = ray.origin.distanceTo(rayPoint)
            if (depth > 0 && distanceSquared <= (depth * pixelScale * 8) ** 2) accept(curvePoint, depth)
          }
        } else {
          ray.closestPointToPoint(entry.point, rayPoint)
          const depth = ray.origin.distanceTo(rayPoint)
          if (depth > 0 && entry.point.distanceToSquared(rayPoint) <= (depth * pixelScale * 8) ** 2) accept(entry.point, depth)
        }
        if (picked) return { named: entry, point: placement.localToWorld(picked) }
      }
      return null
    },
  }
}

function surfacePositions(node, faces, matrix) {
  const { geometry } = node, source = geometry.getAttribute('position'), index = geometry.index
  const winding = matrix.determinant() < 0 ? [0, 2, 1] : [0, 1, 2]
  const values = new Float32Array(faces.reduce((sum, value) => sum + value, 0) * 9)
  const point = new THREE.Vector3()
  let offset = 0
  for (let face = 0; face < faces.length; face++) {
    if (!faces[face]) continue
    for (const corner of winding) {
      const position = face * 3 + corner
      point.fromBufferAttribute(source, index ? index.getX(position) : position).applyMatrix4(matrix).toArray(values, offset)
      offset += 3
    }
  }
  return values
}

/**
 * Encode the named source triangles before viewer placement in model-local millimetres.
 * @param {object} entry One resolved named feature.
 * @param {THREE.Object3D} placement Viewer placement group.
 * @returns {{meshStl?:string,meshUnavailable?:string}} Optional STL for surface geometry.
 */
export function namedRegionMesh(entry, placement) {
  if (!entry.selectors) return {}
  const parts = []
  let length = 0
  for (const [node, faces] of entry.selectors) {
    const matrix = modelLocalPartMatrix(node, placement)
    if (!matrix) return { meshUnavailable: 'geometry_unavailable' }
    const positions = surfacePositions(node, faces, matrix)
    parts.push(positions)
    length += positions.length
  }
  if (length > STL_LIMITS.maxTriangles * 9) return { meshUnavailable: 'geometry_unavailable' }
  const positions = new Float32Array(length)
  let offset = 0
  for (const part of parts) {
    positions.set(part, offset)
    offset += part.length
  }
  return { meshStl: encodeStlBase64(positions) }
}

/**
 * Draw a named feature without adding annotation geometry to the model or its exports.
 * @param {object} entry Resolved feature.
 * @param {THREE.Object3D} parent Scene that owns the visual.
 * @param {THREE.Object3D} placement Viewer placement group.
 * @param {number} color Cursor or agent highlight color.
 * @param {(node:THREE.Mesh)=>THREE.Mesh} posedNode Select the displayed pose of an original mesh.
 * @param {number} markerRadius Model-local radius for a point marker.
 * @returns {object} Independent overlay, projection anchor and disposal.
 */
export function createNamedRegionVisual(entry, parent, placement, color, posedNode, markerRadius) {
  const root = new THREE.Group(), transforms = new Map()
  const surface = new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide, transparent: true, opacity: 0.64,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false,
  })
  const guide = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false })
  const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, depthTest: false, depthWrite: false })
  const marker = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
  const materials = [surface, guide, fill, marker]
  const anchor = new THREE.Vector3()
  const center = new THREE.Vector3()
  let anchorNode = root
  if (entry.selectors) {
    for (const [node, faces] of entry.selectors) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(surfacePositions(node, faces, new THREE.Matrix4()), 3))
      const mesh = new THREE.Mesh(geometry, surface)
      mesh.matrixAutoUpdate = false
      mesh.renderOrder = 2
      transforms.set(mesh, node)
      if (anchorNode === root) {
        anchorNode = mesh
        for (let i = 0; i < 3; i++) anchor.add(center.fromBufferAttribute(geometry.getAttribute('position'), i))
        anchor.multiplyScalar(1 / 3)
      }
      root.add(mesh)
    }
  } else {
    root.matrixAutoUpdate = false
    if (entry.boxes) {
      for (const bounds of entry.boxes) {
        const origin = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
        const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)
        const mesh = new THREE.Mesh(geometry, fill)
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), guide)
        mesh.position.copy(origin); outline.position.copy(origin)
        root.add(mesh, outline)
      }
      entry.boxes[0].getCenter(anchor)
    } else if (entry.points) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(entry.points), guide)
      root.add(line)
      anchor.copy(entry.points[Math.floor(entry.points.length / 2)])
    } else {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 12, 8), marker)
      sphere.position.copy(entry.point)
      root.add(sphere)
      anchor.copy(entry.point)
    }
    root.traverse(node => { node.renderOrder = 3 })
  }
  parent.add(root)
  return {
    root, entry, anchor: { mesh: anchorNode, point: anchor },
    update() {
      if (!root.visible) return
      if (!entry.selectors) {
        placement.updateWorldMatrix(true, false)
        root.matrix.copy(placement.matrixWorld)
        root.matrixWorldNeedsUpdate = true
        return
      }
      for (const [mesh, original] of transforms) {
        const node = posedNode(original)
        node.updateWorldMatrix(true, false)
        mesh.matrix.copy(node.matrixWorld)
        mesh.matrixWorldNeedsUpdate = true
      }
    },
    dispose() {
      root.removeFromParent()
      root.traverse(node => node.geometry?.dispose())
      for (const material of materials) material.dispose()
    },
  }
}
