import { loadGlbModel } from './glb.js'
/**
 * Three.js viewport: owns rendering, model replacement, and GPU resources.
 *
 * The viewport reconciles a scene view (plain data) into three objects and owns
 * their GPU resources. Project modules build static design hierarchies; the
 * viewport retains camera state and the last successfully built design.
 */
import * as THREE from 'three'
import { createHover } from './hover.js'
import { createHighlight } from './highlight.js'
import { buildModel, disposeModel } from './model.js'
import { placeMesh } from '../transform.js'
import { analyzeMesh } from '../checks.js'
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
 * @param {Function} [onCursorMode] Receives cursor selection scope changes.
 * @returns {object} The owned viewport. `apply(view)` reconciles STL objects;
 * `applyDesign(spec, volume)` loads a source revision and resolves to measured
 * geometry. Stale loads resolve to null; build failures reject and retain the
 * previous design. `dispose()` releases the viewport and invalidates imports.
 */
export function createViewport(element, onFailure, onCursorMode = () => {}) {
  const scene = new THREE.Scene()
  const geometries = new Map()
  const objects = new Map()
  const designRoot = new THREE.Group()
  designRoot.matrixAutoUpdate = false
  scene.add(designRoot)
  let highlightOverlay = null, highlightId = null, highlightVisible = true
  let design = null, designUrl = null, requestedUrl = null, generation = 0, cameraCommand = null
  let sceneRevision = 0
  let designSpec = null, designVolume = null, designPending = null
  let measurement = null
  const cursorAnchors = new Map()
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
  const lost = (event) => { event.preventDefault(); onFailure() }
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

  const hover = createHover(renderer.domElement, camera,
    () => [...objects.values()].map(entry => entry.mesh).concat(design ? [design.root] : []), render, onCursorMode)
  const cameraChanged = () => { if (!hover.invalidate()) render() }

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
    if (design) bounds.expandByObject(designRoot)
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
    hover.invalidate()
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    // The first frame needs the real aspect ratio, which only exists after a resize.
    if (!framed && (objects.size > 0 || design !== null)) { framed = true; frame() }
    render()
  })
  observer.observe(element)
  controls.addEventListener('change', cameraChanged)
  renderer.domElement.addEventListener('webglcontextlost', lost)

  function clearHighlight() {
    if (highlightOverlay) { highlightOverlay.dispose() }
    highlightOverlay = null
    highlightId = null
  }

  function syncHighlight() {
    const highlight = designUrl === designSpec?.url ? designSpec?.highlight : null
    if (highlightOverlay && highlightId === (highlight?.id ?? null)) return
    if (!design) { clearHighlight(); return }
    if (highlightOverlay) highlightOverlay.update(highlight ?? { blobs: [] })
    else highlightOverlay = createHighlight(design.root, highlight ?? { blobs: [] }, hover)
    highlightOverlay.setVisible(highlightVisible)
    highlightId = highlight?.id ?? null
  }

  function placeDesign() {
    if (!design || !designSpec) return null
    const key = JSON.stringify([designSpec.transform, designVolume])
    if (measurement?.design !== design || measurement.key !== key) {
      const placed = placeMesh(design.positions, designSpec.transform)
      designRoot.matrix.fromArray(placed.matrix)
      designRoot.updateMatrixWorld(true)
      measurement = { design, key, report: analyzeMesh(placed.positions, { volume: designVolume }) }
    }
    if (!framed) { framed = true; frame() }
    if (designSpec.camera && cameraCommand !== designSpec.camera.id) {
      cameraCommand = designSpec.camera.id
      frame()
      const bounds = new THREE.Box3().setFromObject(designRoot)
      const center = bounds.getCenter(new THREE.Vector3())
      const distance = Math.max(camera.position.distanceTo(center), bounds.getBoundingSphere(new THREE.Sphere()).radius * 2)
      const azimuth = THREE.MathUtils.degToRad(designSpec.camera.azimuth)
      const elevation = THREE.MathUtils.degToRad(designSpec.camera.elevation)
      camera.position.set(
        center.x + distance * Math.cos(elevation) * Math.sin(azimuth),
        center.y - distance * Math.cos(elevation) * Math.cos(azimuth),
        center.z + distance * Math.sin(elevation),
      )
      controls.target.copy(center)
      controls.update()
    }
    syncHighlight()
    hover.invalidate()
    render()
    return measurement.report
  }

  return {
    /** The highlight drawn by the visible viewport, or null when it cannot be acknowledged. */
    renderedHighlight() {
      return !closed && !document.hidden && highlightVisible && designUrl === designSpec?.url ? highlightId : null
    },
    /** Capture the live cursor region and current camera view; no previous hover is reused. */
    captureCursor(request = {}) {
      if (closed || document.hidden) return { status: 'viewer_unavailable' }
      if (design && designUrl !== designSpec?.url) return { status: 'stale_view' }
      const anchor = request.anchorId ? cursorAnchors.get(request.anchorId) : null
      const identityKey = JSON.stringify([sceneRevision, designUrl, designSpec?.transform])
      if (request.command && (!anchor || anchor.identityKey !== identityKey)) return { status: 'stale_view' }
      const hit = request.command ? hover.refine(request.command, anchor.hit) : hover.snapshot()
      if (!hit) return { status: 'no_hit' }
      const designIdentity = design ? {
        path: designSpec.path, revision: designSpec.revision, url: designUrl, transform: designSpec.transform,
      } : null
      let object = hit.object, objectId = null, path = []
      while (object && object !== designRoot && object !== scene) {
        path.unshift(object.name || `child[${object.parent ? object.parent.children.indexOf(object) : 0}]`)
        for (const [id, entry] of objects) if (entry.mesh === object) objectId = id
        object = object.parent
      }
      const point = hit.point.toArray()
      const anchorId = crypto.randomUUID()
      cursorAnchors.set(anchorId, { hit, identityKey })
      while (cursorAnchors.size > 8) cursorAnchors.delete(cursorAnchors.keys().next().value)
      const selection = { partPath: path, surfaceId: hit.surfaceId, mode: ['patch', 'surface', 'part', 'edge'][hit.mode] }
      let modelLocalBlob = null
      if (object === designRoot) {
        const center = designRoot.worldToLocal(hit.point.clone()).toArray()
        const radius = hit.radius / Math.abs(designRoot.getWorldScale(new THREE.Vector3()).x)
        modelLocalBlob = { center, radii: [radius, radius, radius], rotationDegrees: [0, 0, 0] }
      }
      const size = renderer.getSize(new THREE.Vector2())
      const ratio = renderer.getPixelRatio()
      const factor = Math.min(1, 960 / Math.max(size.x, size.y))
      let image
      try {
        renderer.setPixelRatio(1)
        renderer.setSize(Math.max(1, Math.round(size.x * factor)), Math.max(1, Math.round(size.y * factor)), false)
        renderer.render(scene, camera)
        image = renderer.domElement.toDataURL('image/png')
      } finally {
        renderer.setPixelRatio(ratio)
        renderer.setSize(size.x, size.y, false)
        render()
      }
      return {
        status: 'captured', capturedAt: new Date().toISOString(),
        identity: { sceneRevision, design: designIdentity },
        region: { objectId, partPath: path, faceIndex: hit.faceIndex, worldPoint: point, worldRadius: hit.radius, modelLocalBlob, selection, anchorId },
        camera: { position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), fov: camera.getEffectiveFOV(), aspect: camera.aspect },
        image,
      }
    },
    /** Refine the cursor locally; the next pointer hit uses this selection scope. */
    setCursorMode(command) { hover.refine(command) },
    /** Set local presentation visibility without confirming the proposed region. */
    setHighlightVisible(visible) {
      highlightVisible = visible
      if (highlightOverlay) highlightOverlay.setVisible(visible)
      render()
    },
    /** Capture a fitted 480 × 320 PNG using the loaded geometry; restore the interactive viewport. */
    thumbnail() {
      if (closed || (objects.size === 0 && !design)) return null
      const bounds = new THREE.Box3()
      for (const { mesh } of objects.values()) bounds.expandByObject(mesh)
      if (design) bounds.expandByObject(designRoot)
      if (bounds.isEmpty()) return null
      const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere())
      const coverCamera = camera.clone()
      coverCamera.aspect = 1.5
      const distance = Math.max(radius, 1) / Math.sin(coverCamera.fov * Math.PI / 360) * 1.15
      coverCamera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).setLength(distance))
      coverCamera.near = Math.max(distance / 1000, 0.001)
      coverCamera.far = distance + radius * 4 + 1
      coverCamera.lookAt(center)
      coverCamera.updateProjectionMatrix()
      const size = renderer.getSize(new THREE.Vector2())
      const ratio = renderer.getPixelRatio()
      const overlayVisible = highlightVisible
      const hoverRadius = hover.sphere.value.w
      const visibility = volumeNodes.map(node => node.visible)
      try {
        hover.sphere.value.w = 0
        if (highlightOverlay) highlightOverlay.setVisible(false)
        for (const node of volumeNodes) node.visible = false
        renderer.setPixelRatio(1)
        renderer.setSize(480, 320, false)
        renderer.render(scene, coverCamera)
        return renderer.domElement.toDataURL('image/png')
      } finally {
        hover.sphere.value.w = hoverRadius
        if (highlightOverlay) highlightOverlay.setVisible(overlayVisible)
        volumeNodes.forEach((node, index) => { node.visible = visibility[index] })
        renderer.setPixelRatio(ratio)
        renderer.setSize(size.x, size.y, false)
        render()
      }
    },
    async applyDesign(spec, volume) {
      if (closed) return null
      if (designUrl !== spec?.url) { hover.clear(); cursorAnchors.clear() }
      designSpec = spec
      designVolume = volume
      if (!spec) {
        generation++
        clearHighlight()
        if (design) { designRoot.remove(design.root); disposeModel(design.root) }
        measurement = null; design = null; designUrl = null; requestedUrl = null
        render()
        return null
      }
      if (designUrl === spec.url) return placeDesign()
      if (requestedUrl === spec.url) return designPending
      syncHighlight()
      render()
      requestedUrl = spec.url
      const request = ++generation
      designPending = (async () => {
        try {
          let next
          if (spec.format === 'glb') next = await loadGlbModel(spec.url)
          else {
            const module = await import(/* @vite-ignore */ spec.url)
            if (closed || request !== generation) return null
            next = buildModel(module.build)
          }
          if (closed || request !== generation) { disposeModel(next.root); return null }
          // Validate placement before replacing the last successful design.
          placeMesh(next.positions, designSpec.transform)
          clearHighlight()
          if (design) { designRoot.remove(design.root); disposeModel(design.root) }
          design = next
          designUrl = spec.url
          designRoot.add(next.root)
          return placeDesign()
        } catch (error) {
          if (closed || request !== generation) return null
          throw error
        }
      })()
      return designPending
    },
    apply(view) {
      if (closed) return
      if (sceneRevision !== view.revision) { hover.clear(); cursorAnchors.clear() }
      sceneRevision = view.revision
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
        const rebuildOverlay = !entry.overlay || entry.sourceMaterial !== material || entry.datablockId !== spec.datablockId
        if (rebuildOverlay) {
          if (entry.overlay) entry.overlay.dispose()
          entry.mesh.material = material
          entry.sourceMaterial = material
        }
        if (entry.datablockId !== spec.datablockId) {
          entry.mesh.geometry = geometry
          entry.datablockId = spec.datablockId
        }
        entry.mesh.matrix.fromArray(spec.matrix)
        entry.mesh.updateMatrixWorld(true)
        if (rebuildOverlay) entry.overlay = createHighlight(entry.mesh, { blobs: [] }, hover)
      }
      for (const [id, entry] of objects) {
        if (live.has(id)) continue
        entry.overlay.dispose()
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
      if (!framed && (objects.size > 0 || design !== null) && renderer.domElement.width > 0) {
        framed = true
        frame()
      }
      render()
    },
    dispose() {
      if (closed) return
      closed = true
      generation++
      hover.dispose()
      cursorAnchors.clear()
      clearHighlight()
      if (design) disposeModel(design.root)
      design = null
      measurement = null
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      for (const entry of objects.values()) entry.overlay.dispose()
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
