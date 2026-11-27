/** Dotted enclosure stretched along the interactive camera's line of sight. */
import * as THREE from 'three'

const CAMERA_RADIUS_FRACTION = 0.72
const DEPTH_STRETCH = 5

/**
 * Create the dotted enclosure and apply its ink color and opacity from the viewer theme.
 * @param {HTMLElement} element - The stage inheriting the viewer's theme tokens.
 * @param {string} ink - The default dot color when theme tokens are unavailable.
 * @param {number} pixelRatio - The interactive renderer's pixel ratio.
 * @param {() => void} redraw - Redraw after the document's theme changes.
 * @returns {object} The enclosure, its camera updates, and its resource disposer.
 */
export function createSphereGrid(element, ink, pixelRatio, redraw) {
  const positions = []
  const rows = 84
  for (let row = 0; row < rows; row++) {
    const latitude = Math.PI * ((row + 0.5) / rows - 0.5)
    const width = Math.cos(latitude), y = Math.sin(latitude)
    const count = Math.max(1, Math.round(2 * rows * width))
    for (let column = 0; column < count; column++) {
      const longitude = 2 * Math.PI * column / count
      positions.push(-width * Math.sin(longitude), y, -width * Math.cos(longitude))
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const uniforms = {
    ink: { value: new THREE.Color(ink) }, opacity: { value: 0.28 },
    size: { value: 2.6 * pixelRatio }, depthRadius: { value: 1 },
  }
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: /* glsl */ `
      uniform float size;
      uniform float depthRadius;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // The offset keeps the perspective-scaled diameter finite at the camera plane.
        float eyeDepth = max(gl_Position.w, 0.0) / depthRadius;
        gl_PointSize = size / (eyeDepth + 0.0625);
        // Preserve the perspective projection while keeping the dots behind every model pixel.
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 ink;
      uniform float opacity;
      void main() {
        float edge = length(gl_PointCoord - vec2(0.5));
        gl_FragColor = vec4(ink, opacity * (1.0 - smoothstep(0.22, 0.5, edge)));
        #include <colorspace_fragment>
      }
    `,
  })
  const points = new THREE.Points(geometry, material)
  points.name = 'Rumi sphere grid'
  points.layers.set(1)
  points.frustumCulled = false
  points.renderOrder = -1
  const shell = new THREE.Group()
  shell.layers.mask = points.layers.mask
  shell.add(points)
  const dotOrientation = new THREE.Quaternion()

  function frame(camera) {
    dotOrientation.copy(camera.quaternion)
    shell.scale.setScalar(1)
  }

  function update(camera, target, bounds) {
    const cameraRadius = camera.position.distanceTo(target) / CAMERA_RADIUS_FRACTION
    const contentRadius = bounds.isEmpty() ? 0 : (bounds.radius + bounds.center.distanceTo(target)) * 1.05
    const radius = Math.max(shell.scale.x, cameraRadius, contentRadius)
    shell.position.copy(target)
    shell.quaternion.copy(camera.quaternion)
    shell.scale.set(radius, radius, radius * DEPTH_STRETCH)
    uniforms.depthRadius.value = shell.scale.z
    // Rotate the dots in the shell's local space before its depth stretch.
    points.quaternion.copy(camera.quaternion).invert().multiply(dotOrientation)
  }

  function tint() {
    const style = getComputedStyle(element)
    const color = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
    const opacity = Number.parseFloat(style.getPropertyValue('--pv-grid-opacity'))
    if (color) uniforms.ink.value.setStyle(color)
    if (Number.isFinite(opacity)) uniforms.opacity.value = opacity
  }
  tint()
  const theme = document.body ? new MutationObserver(() => { tint(); redraw() }) : null
  theme?.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return { shell, frame, update, dispose() { theme?.disconnect(); geometry.dispose(); material.dispose() } }
}
