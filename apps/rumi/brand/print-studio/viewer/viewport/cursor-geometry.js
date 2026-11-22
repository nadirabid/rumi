/** Export the source faces selected by the viewport's cursor. */
import * as THREE from 'three'
import { encodeStl, STL_LIMITS } from '../stl.js'
import { createSurfaceIndex } from './surfaces.js'

/** The Gaussian support is shared by the cursor shader and the geometry export. */
export const CURSOR_FALLOFF = Object.freeze({ threshold: 0.08, exponent: 1.5 })
const radiusSquaredFactor = -Math.log(CURSOR_FALLOFF.threshold) / CURSOR_FALLOFF.exponent

/**
 * Copy original triangles in model-local millimetres, including transforms inside the model.
 * Patch mode selects faces intersecting the cursor's falloff on the selected surface.
 * Edge mode selects incident faces whose boundary edge intersects that falloff.
 * @param {object} hit Visible mesh, face and point from cursor picking.
 * @param {THREE.Mesh} savedNode Corresponding saved mesh, including when posing the assembly.
 * @param {THREE.Object3D} placement Viewer placement group to exclude from the export.
 * @param {'surface' | 'part' | 'patch' | 'edge'} mode Capture scope.
 * @returns {{meshStl: string} | {meshUnavailable: string}} Base64 binary STL or an unavailable reason.
 */
export function cursorMeshSnapshot(hit, savedNode, placement, mode) {
  const geometry = hit.object.geometry
  const positions = geometry.getAttribute('position')
  const index = geometry.index
  const count = (index?.count ?? positions.count) / 3
  if (count > STL_LIMITS.maxTriangles) return { meshUnavailable: 'geometry_unavailable' }
  const spatial = geometry.userData.rumiSurfaceIndex ?? createSurfaceIndex(geometry)
  if (spatial.surface(hit.faceIndex) !== hit.surfaceId) return { meshUnavailable: 'geometry_unavailable' }

  hit.object.updateWorldMatrix(true, false)
  // Compose from the saved hierarchy without rounding through the viewer's placement.
  const ancestors = []
  for (let node = savedNode; node !== placement; node = node.parent) {
    if (!node) return { meshUnavailable: 'geometry_unavailable' }
    if (node.matrixAutoUpdate) node.updateMatrix()
    ancestors.push(node.matrix)
  }
  const modelLocal = new THREE.Matrix4()
  for (const matrix of ancestors.reverse()) modelLocal.multiply(matrix)
  const winding = modelLocal.determinant() < 0 ? [0, 2, 1] : [0, 1, 2]
  const worldTriangle = new THREE.Triangle(), closest = new THREE.Vector3()
  const corners = [worldTriangle.a, worldTriangle.b, worldTriangle.c]
  const boundary = new THREE.Line3()
  const limit = radiusSquaredFactor * hit.radius ** 2
  const world = hit.object.matrixWorld
  const point = new THREE.Vector3()
  const positionIndex = offset => index ? index.getX(offset) : offset
  const output = new Float32Array(count * 9)
  let length = 0
  for (let face = 0; face < count; face++) {
    if (mode !== 'part' && spatial.surface(face) !== hit.surfaceId) continue
    if (mode === 'patch' || mode === 'edge') {
      corners.forEach((corner, i) => corner.fromBufferAttribute(positions, positionIndex(face * 3 + i)).applyMatrix4(world))
      if (mode === 'patch') {
        worldTriangle.closestPointToPoint(hit.point, closest)
        if (closest.distanceToSquared(hit.point) >= limit) continue
      } else {
        const nearBoundary = corners.some((_, i) => {
          if (!spatial.boundary[face * 9 + i]) return false
          boundary.set(corners[(i + 1) % 3], corners[(i + 2) % 3]).closestPointToPoint(hit.point, true, closest)
          return closest.distanceToSquared(hit.point) < limit
        })
        if (!nearBoundary) continue
      }
    }
    for (const corner of winding) {
      point.fromBufferAttribute(positions, positionIndex(face * 3 + corner)).applyMatrix4(modelLocal).toArray(output, length)
      length += 3
    }
  }
  if (length === 0) return { meshUnavailable: 'empty_selection' }
  const meshStl = new Uint8Array(encodeStl(output.subarray(0, length))).toBase64()
  return { meshStl }
}
