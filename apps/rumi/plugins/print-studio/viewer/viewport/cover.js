/** Studio-lit orthographic 1440×960 cover camera and offscreen thumbnail renderer. */
import * as THREE from 'three'

export const COVER_WIDTH = 1440
export const COVER_HEIGHT = 960

/** Build a studio-lit orthographic camera framed to fit `bounds` cleanly at 3:2. */
export function frameCover(bounds) {
  const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere())
  const distance = Math.max(radius, 1) * 3
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, Math.max(0.01, distance - radius - 1), distance + radius + 1)
  camera.up.set(0, 0, 1)
  camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).setLength(distance))
  camera.lookAt(center)
  camera.updateMatrixWorld()
  const projected = new THREE.Box3(), corner = new THREE.Vector3()
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        projected.expandByPoint(corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse))
      }
    }
  }
  const size = projected.getSize(corner), aspect = COVER_WIDTH / COVER_HEIGHT
  const halfHeight = Math.max(size.x / aspect, size.y, 0.01) * 0.57
  camera.left = -halfHeight * aspect
  camera.right = halfHeight * aspect
  camera.top = halfHeight
  camera.bottom = -halfHeight
  camera.updateProjectionMatrix()
  const key = new THREE.DirectionalLight(0xffffff, 0.68)
  key.position.set(-0.85, 0.95, 0.5)
  key.target.position.set(0, 0, -1)
  const fill = new THREE.DirectionalLight(0xffffff, 0.45)
  fill.position.set(0.9, -0.15, 0.4)
  fill.target = key.target
  camera.add(key, fill, key.target)
  return camera
}

/** Render a clean 1440×960 PNG cover image and restore all interactive viewport state. */
export function captureCoverThumbnail({
  bounds, scene, renderer, light, activity, hover, volumeNodes, namedCursor, showOverlay, highlightVisible, render,
}) {
  const coverCamera = frameCover(bounds)
  const size = renderer.getSize(new THREE.Vector2())
  const ratio = renderer.getPixelRatio()
  const lightVisible = light.visible
  const activityMode = activity.uniform.value.x
  const hoverRadius = hover.sphere.value.w
  const cursorVisible = namedCursor?.root.visible
  const visibility = volumeNodes.map(node => node.visible)
  try {
    hover.sphere.value.w = 0
    activity.uniform.value.x = 0
    showOverlay(false)
    if (namedCursor) namedCursor.root.visible = false
    for (const node of volumeNodes) node.visible = false
    light.visible = false
    scene.add(coverCamera)
    renderer.setPixelRatio(1)
    renderer.setSize(COVER_WIDTH, COVER_HEIGHT, false)
    renderer.render(scene, coverCamera)
    return renderer.domElement.toDataURL('image/png')
  } finally {
    activity.uniform.value.x = activityMode
    hover.sphere.value.w = hoverRadius
    showOverlay(highlightVisible)
    if (namedCursor) namedCursor.root.visible = cursorVisible
    volumeNodes.forEach((node, index) => { node.visible = visibility[index] })
    scene.remove(coverCamera)
    light.visible = lightVisible
    renderer.setPixelRatio(ratio)
    renderer.setSize(size.x, size.y, false)
    render()
  }
}
