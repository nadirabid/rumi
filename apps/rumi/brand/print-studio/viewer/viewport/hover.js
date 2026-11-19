/** Viewport-local Gaussian hover and pinned selection; neither changes scene or session data. */
import * as THREE from 'three'
import { createSurfaceIndex } from './surfaces.js'

const CLICK_SLOP = 4

/**
 * Track the nearest visible model surface and let primary clicks pin and release it.
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
  let clientX = 0, clientY = 0, pinned = null, press = null

  function show(hit) {
    if (hit) {
      sphere.value.set(hit.point.x, hit.point.y, hit.point.z, hit.radius)
      mesh.value = hit.object.id
      surface.value = hit.surfaceId
    } else sphere.value.w = 0
  }

  function cancelUpdate() {
    if (pending !== null) cancelAnimationFrame(pending)
    pending = null
  }

  function update() {
    pending = null
    if (closed || !inside || pinned) return null
    const rect = canvas.getBoundingClientRect()
    let target = null
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
        target = { object: hit.object, faceIndex: hit.faceIndex, surfaceId: hit.surfaceId, point: hit.point, radius, mode: mode.value }
      }
    }
    show(target)
    render()
    return target
  }
  function invalidate() {
    if (closed || !inside || pinned) return false
    if (pending === null) pending = requestAnimationFrame(update)
    return true
  }
  function moved(event) {
    return Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP
  }
  function move(event) {
    if (press && press.id === event.pointerId && moved(event)) press = null
    if (event.pointerType === 'touch' || pinned) return
    clientX = event.clientX; clientY = event.clientY
    inside = true
    invalidate()
  }
  function down(event) {
    press = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null
  }
  function up(event) {
    if (!press || press.id !== event.pointerId) return
    const click = event.button === 0 && !moved(event)
    press = null
    if (!click) return
    const release = Boolean(pinned)
    pinned = null
    cancelUpdate()
    clientX = event.clientX; clientY = event.clientY
    inside = true
    if (release && event.pointerType === 'touch') leave()
    else {
      const hit = update()
      if (!release) pinned = hit
    }
  }
  function lostCapture(event) {
    if (press?.id === event.pointerId) press = null
  }
  function leave() {
    inside = false
    press = null
    cancelUpdate()
    if (pinned) return
    show(null)
    if (!closed) render()
  }
  function clear() {
    pinned = null
    leave()
  }
  const visibility = () => { if (document.hidden) leave() }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointerleave', leave)
  canvas.addEventListener('pointercancel', leave)
  canvas.addEventListener('lostpointercapture', lostCapture)
  window.addEventListener('blur', leave)
  document.addEventListener('visibilitychange', visibility)
  return {
    sphere, mesh, surface, mode, invalidate, clear,
    refine(command, anchor) {
      const modes = { patch: 0, surface: 1, part: 2, edge: 3 }
      const previousScale = radiusScale
      if (command in modes) { mode.value = modes[command]; onMode(command) }
      if (command === 'larger') radiusScale = Math.min(4, radiusScale * 1.5)
      if (command === 'smaller') radiusScale = Math.max(0.25, radiusScale / 1.5)
      if (pinned) pinned = { ...pinned, radius: pinned.radius * (radiusScale / previousScale), mode: mode.value }
      if (anchor) {
        cancelUpdate()
        const ratio = command === 'larger' ? 1.5 : command === 'smaller' ? 1 / 1.5 : 1
        const target = { ...anchor, radius: anchor.radius * ratio, mode: mode.value }
        show(target)
        render()
        return target
      }
      if (pinned) { show(pinned); render() }
      else invalidate()
      return null
    },
    /** Restore the pinned drawing after capturing a separate voice anchor. */
    restorePinned() {
      if (pinned) show(pinned)
    },
    snapshot({ pinnedOnly = false } = {}) {
      if (pinned || pinnedOnly) return pinned
      cancelUpdate()
      return update()
    },
    dispose() {
      closed = true
      clear()
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointercancel', leave)
      canvas.removeEventListener('lostpointercapture', lostCapture)
      window.removeEventListener('blur', leave)
      document.removeEventListener('visibilitychange', visibility)
    },
  }
}
