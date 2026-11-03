/** Frame-coalesced, viewport-local Gaussian hover; never changes scene or session data. */
import * as THREE from 'three'

/**
 * Track the nearest visible model surface without taking over camera gestures.
 * @param {HTMLCanvasElement} canvas - Pointer event target.
 * @param {THREE.PerspectiveCamera} camera - Interactive camera.
 * @param {() => THREE.Object3D[]} roots - Current model roots, excluding printer guides.
 * @param {() => void} render - Draw after the hover uniform changes.
 * @returns {object} Shared sphere uniform, invalidation, clearing and disposal controls.
 */
export function createHover(canvas, camera, roots, render) {
  const sphere = { value: new THREE.Vector4(0, 0, 0, 0) }
  const pointer = new THREE.Vector2()
  const local = new THREE.Vector3()
  const raycaster = new THREE.Raycaster()
  const hits = [], meshes = []
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
      hits.length = 0
      raycaster.intersectObjects(meshes, false, hits)
      const hit = hits.find(entry => {
        const material = Array.isArray(entry.object.material) ? entry.object.material[entry.face.materialIndex] : entry.object.material
        return material.visible
      })
      if (hit) {
        const depth = -local.copy(hit.point).applyMatrix4(camera.matrixWorldInverse).z
        // A 60 CSS-pixel nominal radius remains usable across model scales and zoom levels.
        const radius = 120 * depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / rect.height
        sphere.value.set(hit.point.x, hit.point.y, hit.point.z, radius)
        target = { object: hit.object, faceIndex: hit.faceIndex, point: hit.point.clone(), radius }
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
    sphere, invalidate, clear,
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
