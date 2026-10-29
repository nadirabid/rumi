/**
 * three.js adapter: the only module in the plugin allowed to import three.
 *
 * The viewport reconciles a scene view (plain data) into three objects and owns
 * their GPU resources. It reads no files, measures nothing, and holds no
 * document: camera state is the only thing it keeps that the scene does not.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/** Fallbacks for a stage mounted outside a themed tree, such as a test fixture. */
const FALLBACK_INK = '#8a8a8a'
const FALLBACK_ACCENT = '#3d6fe0'
const FALLBACK_BLOCKED = '#c0392b'

function token(element, name, fallback) {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * Mount a viewport that follows a scene view.
 *
 * The camera is framed once, when the first object arrives, and is the person's
 * afterwards: scene updates never reset an orbit.
 * @param {HTMLElement} element - Container the canvas fills; its size is observed.
 * @param {() => void} onFailure - Called once when the WebGL context is lost.
 * @returns {{apply: (view: object) => void, dispose: () => void}} the viewport; `apply` takes `{volume, objects: [{id, datablockId, positions, matrix, blocked}]}`.
 */
export function createViewport(element, onFailure) {
  const scene = new THREE.Scene()
  const geometries = new Map()
  const objects = new Map()
  const ink = token(element, '--dsw-alias-label-tertiary', FALLBACK_INK)
  const solidMaterial = new THREE.MeshStandardMaterial({
    color: token(element, '--dsw-alias-brand-primary', FALLBACK_ACCENT),
    roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide,
  })
  const blockedMaterial = new THREE.MeshStandardMaterial({
    color: token(element, '--dsw-alias-state-error-primary', FALLBACK_BLOCKED),
    roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide,
  })
  let renderer, controls, observer, volumeNodes = [], volumeKey = 'none', framed = false, closed = false
  const lost = event => { event.preventDefault(); onFailure() }
  const render = () => { if (!closed) renderer.render(scene, camera) }

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.domElement.setAttribute('aria-hidden', 'true')
  element.appendChild(renderer.domElement)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000)
  camera.up.set(0, 0, 1)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  scene.add(new THREE.HemisphereLight(0xffffff, 0x606070, 2.5))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(100, -150, 300)
  scene.add(light)

  function clearVolume() {
    for (const node of volumeNodes) {
      scene.remove(node)
      node.geometry.dispose()
      node.material.dispose()
    }
    volumeNodes = []
  }

  function buildVolume(volume) {
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(volume.x, volume.y),
      new THREE.MeshStandardMaterial({ color: ink, transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
    )
    plate.position.z = -0.1
    const grid = new THREE.GridHelper(Math.max(volume.x, volume.y), 16, ink, ink)
    grid.rotation.x = Math.PI / 2
    grid.material.transparent = true
    grid.material.opacity = 0.18
    const envelope = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(volume.x, volume.y, volume.z)),
      new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.3 }),
    )
    envelope.position.z = volume.z / 2
    volumeNodes = [plate, grid, envelope]
    scene.add(plate, grid, envelope)
  }

  function frame() {
    const bounds = new THREE.Box3()
    for (const { mesh } of objects.values()) bounds.expandByObject(mesh)
    if (bounds.isEmpty()) return
    const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere())
    // The pane is usually taller than wide, so clear the narrower of the two fields.
    const vertical = camera.fov * Math.PI / 180
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect)
    const distance = Math.max(radius, 5) / Math.sin(Math.min(vertical, horizontal) / 2) * 1.15
    camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).setLength(distance))
    controls.target.copy(center)
    controls.update()
  }

  observer = new ResizeObserver(() => {
    const { width, height } = element.getBoundingClientRect()
    if (width <= 0 || height <= 0) return
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    // The first frame needs the real aspect ratio, which only exists after a resize.
    if (!framed && objects.size > 0) { framed = true; frame() }
    render()
  })
  observer.observe(element)
  controls.addEventListener('change', render)
  renderer.domElement.addEventListener('webglcontextlost', lost)

  return {
    apply(view) {
      if (closed) return
      const live = new Set()
      for (const spec of view.objects) {
        live.add(spec.id)
        let geometry = geometries.get(spec.datablockId)
        if (geometry === undefined) {
          geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(spec.positions, 3))
          geometry.computeVertexNormals()
          geometries.set(spec.datablockId, geometry)
        }
        const material = spec.blocked ? blockedMaterial : solidMaterial
        let entry = objects.get(spec.id)
        if (entry === undefined) {
          const mesh = new THREE.Mesh(geometry, material)
          mesh.matrixAutoUpdate = false
          scene.add(mesh)
          entry = { mesh, datablockId: spec.datablockId }
          objects.set(spec.id, entry)
        }
        entry.mesh.material = material
        if (entry.datablockId !== spec.datablockId) {
          entry.mesh.geometry = geometry
          entry.datablockId = spec.datablockId
        }
        entry.mesh.matrix.fromArray(spec.matrix)
        entry.mesh.updateMatrixWorld(true)
      }
      for (const [id, entry] of objects) {
        if (live.has(id)) continue
        scene.remove(entry.mesh)
        objects.delete(id)
      }
      const liveDatablocks = new Set([...objects.values()].map(entry => entry.datablockId))
      for (const [id, geometry] of geometries) {
        if (liveDatablocks.has(id)) continue
        geometry.dispose()
        geometries.delete(id)
      }
      const key = view.volume === null ? 'none' : `${view.volume.x},${view.volume.y},${view.volume.z}`
      if (key !== volumeKey) {
        clearVolume()
        if (view.volume !== null) buildVolume(view.volume)
        volumeKey = key
      }
      if (!framed && objects.size > 0 && renderer.domElement.width > 0) {
        framed = true
        frame()
      }
      render()
    },
    dispose() {
      if (closed) return
      closed = true
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      for (const geometry of geometries.values()) geometry.dispose()
      geometries.clear()
      objects.clear()
      clearVolume()
      solidMaterial.dispose()
      blockedMaterial.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
