/** Frame-coalesced, viewport-local Gaussian hover; never changes scene or session data. */
import * as THREE from 'three'
import { createSurfaceIndex } from './surfaces.js'

/**
 * Track the nearest visible model surface without taking over camera gestures.
 * @param {HTMLCanvasElement} canvas - Pointer event target.
 * @param {THREE.PerspectiveCamera} camera - Interactive camera.
 * @param {() => THREE.Object3D[]} roots - Current model roots, excluding printer guides.
 * @param {() => void} render - Draw after the hover uniform changes.
 * @param {Function} [onMode] Receives the selected scope when a local or voice command changes it.
 * @returns {object} Shared sphere uniform, invalidation, clearing and disposal controls.
 */
export function createHover(canvas, camera, roots, render, onMode = () => {}) {
  const sphere = { value: new THREE.Vector4(0, 0, 0, 0) }
  const pointer = new THREE.Vector2()
  const local = new THREE.Vector3()
  const raycaster = new THREE.Raycaster()
  const meshes = [], indexes = new WeakMap()
  const mesh = { value: -1 }, surface = { value: -1 }, mode = { value: 0 }
  const inverse = new THREE.Matrix4(), ray = new THREE.Ray()
  let radiusScale = 1
  let pending = null, inside = false, closed = false
  let clientX = 0, clientY = 0, target = null
  function update() {
    pending = null
    if (closed || !inside) return
    const rect = canvas.getBoundingClientRect()
    sphere.value.w = 0
    target = null
    if (rect.width > 0 && rect.height > 0 && clientX >= rect.left && clientX <= rect.left + rect.width
      && clientY >= rect.top && clientY <= rect.top + rect.height) {
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2)
      camera.updateWorldMatrix(true, false)
      raycaster.setFromCamera(pointer, camera)
      meshes.length = 0
      for (const root of roots()) {
        root.updateWorldMatrix(true, true)
        root.traverseVisible(node => { if (node.isMesh) meshes.push(node) })
      }
      let hit = null, distance = Infinity
      for (const node of meshes) {
        let spatial = node.geometry.userData.rumiSurfaceIndex ?? indexes.get(node.geometry)
        if (!spatial) { spatial = createSurfaceIndex(node.geometry); indexes.set(node.geometry, spatial) }
        ray.copy(raycaster.ray).applyMatrix4(inverse.copy(node.matrixWorld).invert())
        const picked = spatial.pick(ray, node.material)
        if (!picked) continue
        picked.point.applyMatrix4(node.matrixWorld)
        const nextDistance = camera.position.distanceToSquared(picked.point)
        if (nextDistance < distance) {
          distance = nextDistance
          hit = { ...picked, object: node, surfaceId: spatial.surface(picked.faceIndex) }
        }
      }
      if (hit) {
        const depth = -local.copy(hit.point).applyMatrix4(camera.matrixWorldInverse).z
        // A 60 CSS-pixel nominal radius remains usable across model scales and zoom levels.
        const radius = radiusScale * 120 * depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / rect.height
        sphere.value.set(hit.point.x, hit.point.y, hit.point.z, radius)
        mesh.value = hit.object.id
        surface.value = hit.surfaceId
        target = { object: hit.object, faceIndex: hit.faceIndex, surfaceId: hit.surfaceId, point: hit.point.clone(), radius, mode: mode.value }
      }
    }
    render()
  }
  function invalidate() {
    if (closed || !inside) return false
    if (pending === null) pending = requestAnimationFrame(update)
    return true
  }
  function move(event) {
    if (event.pointerType === 'touch') return
    clientX = event.clientX; clientY = event.clientY
    inside = true
    invalidate()
  }
  function clear() {
    inside = false
    if (pending !== null) cancelAnimationFrame(pending)
    pending = null
    sphere.value.w = 0
    target = null
    if (!closed) render()
  }
  const visibility = () => { if (document.hidden) clear() }
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerleave', clear)
  canvas.addEventListener('pointercancel', clear)
  window.addEventListener('blur', clear)
  document.addEventListener('visibilitychange', visibility)
  return {
    sphere, mesh, surface, mode, invalidate, clear,
    refine(command, anchor) {
      const modes = { patch: 0, surface: 1, part: 2, edge: 3 }
      if (command in modes) { mode.value = modes[command]; onMode(command) }
      if (command === 'larger') radiusScale = Math.min(4, radiusScale * 1.5)
      if (command === 'smaller') radiusScale = Math.max(0.25, radiusScale / 1.5)
      if (anchor) {
        if (pending !== null) cancelAnimationFrame(pending)
        pending = null
        const ratio = command === 'larger' ? 1.5 : command === 'smaller' ? 1 / 1.5 : 1
        target = { ...anchor, radius: anchor.radius * ratio, mode: mode.value }
        sphere.value.set(...target.point.toArray(), target.radius)
        mesh.value = target.object.id
        surface.value = target.surfaceId
        render()
        return target
      }
      invalidate()
      return null
    },
    snapshot() {
      if (closed || !inside) return null
      if (pending !== null) cancelAnimationFrame(pending)
      update()
      return target
    },
    dispose() {
      closed = true
      clear()
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', clear)
      canvas.removeEventListener('pointercancel', clear)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', visibility)
    },
  }
}
