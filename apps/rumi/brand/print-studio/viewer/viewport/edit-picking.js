/** Pick the rendered surface of an edit, including shader displacement and clipping. */
import * as THREE from 'three'

/**
 * Render one pixel with the viewport's actual depth and stencil tests.
 * @param {THREE.WebGLRenderer} renderer Shared viewport renderer.
 * @param {THREE.Scene} scene Interactive scene.
 * @param {THREE.PerspectiveCamera} camera Interactive camera.
 * @returns {object} Shared shader uniform, surface picker and disposer.
 */
export function createEditPicker(renderer, scene, camera) {
  const active = { value: false }
  const pixel = new Float32Array(4)
  const pickCamera = camera.clone(false)
  let target = null
  return {
    active,
    pick(pointer, ray, decorations) {
      if (!renderer.extensions.has('EXT_color_buffer_float')) return null
      target ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, stencilBuffer: true })
      const { width, height } = renderer.domElement
      pickCamera.copy(camera, false)
      pickCamera.setViewOffset(width, height, (pointer.x + 1) * width / 2 - 0.5, (1 - pointer.y) * height / 2 - 0.5, 1, 1)
      const previousTarget = renderer.getRenderTarget()
      const visibility = decorations.map(node => node.visible)
      const transparent = new Map()
      try {
        for (const node of decorations) node.visible = false
        scene.traverseVisible(node => {
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            if (!material?.transparent || transparent.has(material)) continue
            transparent.set(material, { blending: material.blending, depthWrite: material.depthWrite })
            material.blending = THREE.NoBlending
            material.depthWrite = true
          }
        })
        active.value = true
        renderer.setRenderTarget(target)
        renderer.render(scene, pickCamera)
        pixel.fill(0)
        renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel)
      } finally {
        active.value = false
        renderer.setRenderTarget(previousTarget)
        for (const [material, state] of transparent) Object.assign(material, state)
        decorations.forEach((node, index) => { node.visible = visibility[index] })
      }
      // Uninstrumented opaque surfaces, including cut caps, can occlude a hit.
      const object = pixel[3] === 2 ? scene.getObjectById(pixel[0]) : null
      return object ? { object, surfaceId: pixel[1], point: ray.at(pixel[2], new THREE.Vector3()) } : null
    },
    dispose() { target?.dispose() },
  }
}
