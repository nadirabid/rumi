import { createFieldPreview } from '../analog/field-preview.js'
import { createSurfacePreview } from '../analog/surface.js'
import { printParts, arrangePrintParts, createPrintPreview, layoutIssues } from './print-layout.js'
import { printLayoutIdentity } from '../print-layout/state.js'
import { createShapeDeformer } from '../analog/gpu.js'
import { createParameterPreview } from '../analog/parameters.js'
import { readMotion } from '../motion.js'
import { controlValues } from '../analog/control-spec.js'
import { parseUsdModel } from './usd.js'
import { createModelArtifacts } from '../generation/artifacts.js'
import { generateStl } from '../generation/export.js'
/**
 * Three.js viewport: owns rendering, model replacement, and GPU resources.
 *
 * The viewport reconciles a scene view (plain data) into three objects and owns
 * their GPU resources. Project modules build static design hierarchies; the
 * viewport retains camera state and the last successfully built design.
 */
import * as THREE from 'three'
import { createActivity } from './activity.js'
import { createSphereGrid } from './sphere-grid.js'
import { createHover } from './hover.js'
import { createHighlight } from './highlight.js'
import { cursorMeshSnapshot } from './cursor-geometry.js'
import { MAX_CURSOR_IMAGE_CHARS } from '../image-limits.js'
import { createNamedRegionIndex, createNamedRegionVisual, namedRegionMesh } from './named-regions.js'
import { createRegionPicker, regionAnchor } from './region-marker.js'
import { modelRegionReference } from '../model-regions.js'
import { createEditPicker } from './edit-picking.js'
import { disposeModel } from './model.js'
import { placeMesh } from '../transform.js'
import { analyzeMesh } from '../checks.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** Fallbacks for a stage mounted outside a themed tree, such as a test fixture. */
const FALLBACK_INK = '#8a8a8a'
const FALLBACK_ACCENT = '#3d6fe0'
const FALLBACK_BLOCKED = '#c0392b'
const COVER_WIDTH = 1440
const COVER_HEIGHT = 960

function token(element, name, fallback) {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

function frameCover(bounds) {
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

/**
 * Mount a viewport that follows a scene view.
 *
 * The camera is framed once, when the first object arrives, and is the person's
 * afterwards: scene updates never reset an orbit.
 * @param {HTMLElement} element - Container the canvas fills; its size is observed.
 * @param {() => void} onFailure - Called once when the WebGL context is lost.
 * @param {Function} [onCursorMode] Receives cursor selection scope changes.
 * @param {object} [sharedArtifacts] Client-owned saved GLBs shared with validation.
 * @param {Function} [onPrintLayout] Receives local print placement and issue changes; omitted when no layout UI is mounted.
 * @param {Function} [onRegionMarker] Receives the projected named highlight, or null when it is unavailable.
 * @returns {object} The owned viewport. `apply(view)` reconciles STL objects;
 * `applyDesign(spec, volume)` loads a source revision and resolves to measured
 * geometry. Stale loads resolve to null; build failures reject and retain the
 * previous design. `dispose()` releases the viewport and invalidates imports.
 */
export function createViewport(element, onFailure, onCursorMode = () => {}, sharedArtifacts, onPrintLayout = () => {}, onRegionMarker = () => {}) {
  const artifacts = sharedArtifacts ?? createModelArtifacts(), tasks = new Set()
  function track(work) {
    tasks.add(work)
    void work.finally(() => tasks.delete(work)).catch(() => {})
    return work
  }
  function disposeDesign(model) { disposeModel(model.root); model.release?.() }
  const scene = new THREE.Scene()
  const geometries = new Map()
  const objects = new Map()
  const designRoot = new THREE.Group()
  designRoot.matrixAutoUpdate = false
  scene.add(designRoot)
  let shapeDeformer = null, shapeId = null, shapeOperation = null, shapeFrame = null, shapeValues = null, inputTime = 0
  let motion = null, motionPreview = null
  let motionOverlay = null, motionFrame = null
  let printPreview = null, printableParts = null, printLayout = null, printPlate = 0, printSelected = null, printDrag = null
  const printUndo = []
  let printFrame = null
  function printSnapshot() {
    return { active: Boolean(printPreview), manufacturingMode: design?.robot?.assembly?.manufacturing.mode ?? null, layout: printLayout ? structuredClone(printLayout) : null, plate: printPlate, selected: printSelected,
      parts: printableParts?.map(part => ({ id: part.id, name: part.name })) ?? [],
      issues: printLayout && printableParts ? layoutIssues(printableParts, printLayout) : [], canUndo: printUndo.length > 0 }
  }
  function publishPrint() { onPrintLayout(printSnapshot()) }
  function clearPrint(forget = false, restore = true) {
    if (printFrame !== null) cancelAnimationFrame(printFrame)
    printFrame = null
    printPreview?.dispose(); printPreview = null; designRoot.visible = true
    const pointerId = printDrag?.pointerId
    if (printDrag) printLayout = printDrag.previous
    printDrag = null
    if (pointerId !== undefined && renderer.domElement.hasPointerCapture(pointerId)) renderer.domElement.releasePointerCapture(pointerId)
    if (controls) controls.enabled = true
    if (forget) { printableParts = null; printLayout = null; printUndo.length = 0; printSelected = null; printPlate = 0 }
    if (restore) {
      highlightOverlay?.resume(); showOverlay(highlightVisible)
      clearVolume()
      if (designVolume) buildVolume(designVolume)
      volumeKey = designVolume ? `${designVolume.x},${designVolume.y},${designVolume.z}` : 'none'
      publishPrint()
    }
  }
  function drawPrint() { printPreview.apply(printLayout, printPlate, printSelected); render() }
  const poses = new Map()
  function clearMotion() { if (motionPreview) clearHighlight(); motionPreview?.dispose(); motionPreview = null }
  function showMotion() {
    if (!motion || !design || shapeDeformer || printPreview) return
    if (Object.entries(motion.values).every(([key, value]) => design.parameters[key] === value)) { clearMotion(); return }
    if (!motionPreview) {
      clearHighlight()
      motionPreview = design.createMotionPreview(designRoot)
    }
    motionPreview.update(motion.values)
    if (surfaceOverlay) surfaceOverlay.matrixWorldNeedsUpdate = true
  }
  const shapeMetrics = { frames: 0, maxInputToDrawMs: 0, lastDrawMs: 0 }
  function clearShape() {
    if (shapeFrame !== null) cancelAnimationFrame(shapeFrame)
    shapeFrame = null
    if (shapeDeformer) {
      hover.replacePin(null)
      track(Promise.resolve(shapeDeformer.dispose()))
    }
    shapeDeformer = null; shapeId = null; shapeOperation = null
  }
  let highlightOverlay = null, highlightId = null, highlightVisible = true
  let design = null, designUrl = null, requestedUrl = null, generation = 0, cameraCommand = null
  let sceneRevision = 0, sceneGeneration = 0
  let designSpec = null, designVolume = null, designPending = null, requestedRenderRequest = null
  let measurement = null
  const gridBounds = new THREE.Sphere()
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
  const lost = (event) => { event.preventDefault(); activity.dispose(); onFailure() }
  let marker = null, mappedHit = null, regionFocused = false, regionPresented = false
  let namedIndex = null, namedMap = null, namedDesign = null, namedCursor = null, namedAgent = null
  const projected = new THREE.Vector3()
  const motionViewportSize = new THREE.Vector2()
  const jointPoint = new THREE.Vector3(), viewDirection = new THREE.Vector3()
  const motionProjection = { owner: null, values: null, points: [], camera: new THREE.Matrix4(),
    projection: new THREE.Matrix4(), placement: new THREE.Matrix4() }
  function drawMotionOverlay() {
    if (!motionOverlay || motionOverlay.id !== designUrl || !motion || !design || shapeDeformer || printPreview) return
    const owner = motionPreview ?? design
    const posed = motionProjection.owner !== owner || motionProjection.values !== motion.values ||
      !motionProjection.placement.equals(designRoot.matrixWorld)
    if (posed || !motionProjection.camera.equals(camera.matrixWorldInverse) || !motionProjection.projection.equals(camera.projectionMatrix)) {
      if (posed) owner.motionOcclusion.update()
      motionProjection.owner = owner
      motionProjection.values = motion.values
      motionProjection.camera.copy(camera.matrixWorldInverse)
      motionProjection.projection.copy(camera.projectionMatrix)
      motionProjection.placement.copy(designRoot.matrixWorld)
      camera.getWorldDirection(viewDirection)
      motionProjection.points = motion.controls.map((_, index) => {
        owner.motionAnchor(index, jointPoint).applyMatrix4(designRoot.matrixWorld)
        projected.copy(jointPoint).project(camera)
        if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1 ||
            owner.motionOcclusion.hidden(index, camera.position, viewDirection, jointPoint)) return null
        return { x: (projected.x + 1) * 50, y: (1 - projected.y) * 50 }
      })
    }
    motionOverlay.draw(motionProjection.points, renderer.getSize(motionViewportSize).x)
  }
  const pinRay = new THREE.Ray(), pinDirection = new THREE.Vector3()
  const savedOrigin = new THREE.Vector3()
  let markerRadius = 0.15
  function namedVisual(entry, color) {
    return createNamedRegionVisual(entry, scene, designRoot, color, node => motionPreview?.posedHit(node, savedOrigin)?.object ?? node, markerRadius)
  }
  function updateNamedHit(hit, pinned) {
    const entry = hit?.named
    if (namedCursor && namedCursor.entry !== entry) { namedCursor.dispose(); namedCursor = null }
    mappedHit = null
    if (!entry) return
    if (!namedCursor) namedCursor = namedVisual(entry, 0x9ab9e1)
    const { region } = entry
    const mesh = hit.object ?? designRoot
    mappedHit = { id: modelRegionReference(designSpec, region.id), name: region.name, mesh,
      point: mesh.worldToLocal(hit.point.clone()), interactive: Boolean(pinned) }
  }
  function updateNamedIndex() {
    const map = designUrl === designSpec?.url ? designSpec?.regionMap ?? null : null
    if (namedMap?.key === map?.key && namedDesign === design) return
    if (namedCursor) updateNamedHit(null)
    namedAgent?.dispose(); namedAgent = null
    if (designSpec?.highlight?.regionId) highlightId = null
    namedMap = map; namedDesign = design
    namedIndex = map && design ? createNamedRegionIndex(design.root, designRoot, map.regions) : null
    if (namedIndex) {
      const bounds = new THREE.Box3()
      for (let i = 0; i < design.positions.length; i += 3) bounds.expandByPoint(projected.fromArray(design.positions, i))
      markerRadius = Math.max(bounds.getSize(projected).length() * 0.007, 0.15)
    }
  }
  function updateNamedVisuals() {
    const ready = !printPreview && !shapeDeformer && designUrl === designSpec?.url
    if (namedAgent) {
      namedAgent.root.visible = ready && highlightVisible
      namedAgent.update()
    }
    if (namedCursor) {
      namedCursor.root.visible = ready && !(namedAgent?.root.visible && namedAgent.entry === namedCursor.entry)
      namedCursor.update()
    }
  }
  const render = () => {
    if (closed) return
    if (motionFrame !== null) { cancelAnimationFrame(motionFrame); motionFrame = null }
    updateNamedVisuals()
    grid.update(camera, controls.target, gridBounds)
    const modelLayers = camera.layers.mask
    camera.layers.mask |= grid.shell.layers.mask
    try { renderer.render(scene, camera) }
    finally { camera.layers.mask = modelLayers }
    drawMotionOverlay()
    const highlight = marker && surfaceOverlay.visible ? marker.hit ?? (regionFocused ? marker.anchor : null) : null
    const named = namedAgent?.entry.region
    const namedFocus = namedAgent?.root.visible && regionFocused ? {
      ...namedAgent.anchor, id: modelRegionReference(designSpec, named.id),
      name: named.name, interactive: true,
    } : null
    const anchor = !printPreview && !shapeDeformer && mappedHit ? mappedHit : namedFocus
      ?? (highlight ? { ...highlight, id: marker.id, name: marker.name, interactive: marker.pinned || regionFocused } : null)
    if (!anchor) {
      if (regionPresented) onRegionMarker(null)
      regionPresented = false
      return
    }
    projected.copy(anchor.point).applyMatrix4(anchor.mesh.matrixWorld).project(camera)
    const visible = Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1
    regionPresented = visible
    onRegionMarker(visible ? { id: anchor.id, name: anchor.name,
      x: (projected.x + 1) * 50, y: (1 - projected.y) * 50, interactive: anchor.interactive } : null)
  }

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.domElement.setAttribute('aria-hidden', 'true')
  element.appendChild(renderer.domElement)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000)
  camera.up.set(0, 0, 1)
  const grid = createSphereGrid(element, ink, renderer.getPixelRatio(), render)
  scene.add(grid.shell)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  const activity = createActivity(element, render)
  // Image-based light from every direction shades all faces at any orbit angle.
  // RoomEnvironment is Y up; the rotation puts its ceiling at the scene's +Z.
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment()
  const environment = pmrem.fromScene(room, 0.04)
  room.dispose(); pmrem.dispose()
  scene.environment = environment.texture
  scene.environmentRotation.x = Math.PI / 2
  // Below full strength so pale materials keep shading instead of clipping to white.
  scene.environmentIntensity = 0.75
  // A weak light fixed above the camera's left shoulder adds a specular highlight that follows the view.
  const light = new THREE.DirectionalLight(0xffffff, 0.5)
  light.position.set(-0.5, 0.7, 0)
  light.target.position.set(0, 0, -1)
  camera.add(light, light.target)
  scene.add(camera)

  const editPicker = createEditPicker(renderer, scene, camera)
  const hover = createHover(renderer.domElement, camera,
    () => printPreview ? [] : [...objects.values()].map(entry => entry.mesh).concat(design ? [designRoot] : []), render, onCursorMode,
    (pointer, ray) => shapeDeformer ? editPicker.pick(pointer, ray, surfaceOverlay ? [...volumeNodes, surfaceOverlay] : volumeNodes) : undefined,
    (hit, ray, pinned) => {
      updateNamedHit(hit, pinned)
      if (!marker) return
      marker.hit = marker.pick(hit, ray)
      marker.pinned = Boolean(marker.hit && pinned)
    }, () => {
      if (motionOverlay?.id === designUrl) motionOverlay.onCanvasClick?.()
    }, (hit, ray, pixelScale) => {
      if (!namedIndex || designUrl !== designSpec?.url || printPreview || shapeDeformer) return null
      const saved = hit && motionPreview?.savedHit(hit.object, hit.point)
      return namedIndex.pick(hit, saved?.node ?? hit?.object, ray, pixelScale)
    })
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

  function previewBounds() {
    const bounds = new THREE.Box3()
    for (const { mesh } of objects.values()) bounds.expandByObject(mesh)
    if (printPreview) { bounds.expandByObject(printPreview.root); if (volumeNodes[0]) bounds.expandByObject(volumeNodes[0]) }
    else if (design) bounds.expandByObject(designRoot)
    return bounds
  }

  function updateGridBounds() {
    previewBounds().getBoundingSphere(gridBounds)
  }

  function frame() {
    updateGridBounds()
    if (gridBounds.isEmpty()) return
    const { center, radius } = gridBounds
    // The pane is usually taller than wide, so clear the narrower of the two fields.
    const vertical = camera.fov * Math.PI / 180
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect)
    const distance = Math.max(radius, 5) / Math.sin(Math.min(vertical, horizontal) / 2) * 1.15
    camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).setLength(distance))
    controls.target.copy(center)
    controls.update()
    grid.frame(camera)
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

  let surfaceOverlay = null, surfaceMaterial = null
  function clearSurfaceOverlay() {
    if (!surfaceOverlay) return
    if (marker) { marker = null; onRegionMarker(null) }
    surfaceOverlay.removeFromParent()
    surfaceOverlay.traverse(node => { if (node.isMesh) node.geometry.dispose() })
    surfaceMaterial.dispose()
    surfaceMaterial = null
    surfaceOverlay = null
  }
  function showOverlay(visible) {
    highlightOverlay?.setVisible(visible)
    if (surfaceOverlay) surfaceOverlay.visible = visible && !printPreview
    if (namedAgent) namedAgent.root.visible = visible && !printPreview && !shapeDeformer
  }

  function clearHighlight() {
    clearSurfaceOverlay()
    namedAgent?.dispose(); namedAgent = null
    if (highlightOverlay) { highlightOverlay.dispose() }
    highlightOverlay = null
    highlightId = null
  }

  function syncHighlight() {
    if (printPreview) return
    const highlight = designUrl === designSpec?.url ? designSpec?.highlight : null
    if (highlightOverlay && highlightId === (highlight?.id ?? null)) return
    if (!design) { clearHighlight(); return }
    clearSurfaceOverlay()
    namedAgent?.dispose(); namedAgent = null
    if (highlight?.regionId && highlight.regionMapKey === namedMap?.key) {
      const entry = namedIndex?.get(highlight.regionId)
      if (entry) namedAgent = namedVisual(entry, 0x29b59d)
    }
    if (highlight?.positions) {
      surfaceMaterial = new THREE.MeshBasicMaterial({ color: 0x29b59d, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthWrite: false })
      const parts = motionPreview?.overlayParts(highlight.positions)
      const meshFor = positions => {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const mesh = new THREE.Mesh(geometry, surfaceMaterial)
        mesh.renderOrder = 1
        return mesh
      }
      surfaceOverlay = parts ? new THREE.Group() : meshFor(highlight.positions)
      for (const part of parts ?? []) {
        const mesh = meshFor(part.positions)
        mesh.matrixAutoUpdate = false
        if (part.transform) mesh.matrix = part.transform
        surfaceOverlay.add(mesh)
      }
      surfaceOverlay.name = 'Rumi highlight overlay'
      surfaceOverlay.matrixAutoUpdate = false
      surfaceOverlay.matrix = designRoot.matrix
      scene.add(surfaceOverlay)
      if (highlight.regionName) {
        let mesh = surfaceOverlay.isMesh ? surfaceOverlay : null
        for (const child of surfaceOverlay.children) {
          if (!mesh || child.geometry.getAttribute('position').count > mesh.geometry.getAttribute('position').count) mesh = child
        }
        if (mesh) {
          const pick = createRegionPicker(surfaceOverlay)
          const pin = hover.snapshot({ pinnedOnly: true })
          const hit = pin ? pick(pin, pinRay.set(camera.position, pinDirection.copy(pin.point).sub(camera.position).normalize())) : null
          marker = { id: highlight.id, name: highlight.regionName, pick, anchor: { mesh, point: regionAnchor(mesh) }, hit, pinned: Boolean(hit) }
          hover.invalidate()
        }
      }
    }
    if (highlightOverlay) highlightOverlay.update(highlight?.blobs ? highlight : { blobs: [] })
    else highlightOverlay = createHighlight(motionPreview?.root ?? design.root, highlight?.blobs ? highlight : { blobs: [] }, hover, activity.uniform, editPicker.active)
    showOverlay(highlightVisible)
    highlightId = highlight?.regionId && !namedAgent ? null : highlight?.id ?? null
  }

  function placeDesign() {
    if (!design || !designSpec) return null
    updateNamedIndex()
    const key = JSON.stringify([designSpec.transform, designVolume])
    if (measurement?.design !== design || measurement.key !== key) {
      const placed = placeMesh(design.positions, designSpec.transform)
      designRoot.matrix.fromArray(placed.matrix)
      designRoot.updateMatrixWorld(true)
      measurement = { design, key, report: analyzeMesh(placed.positions, { volume: designVolume }) }
      if (framed) updateGridBounds()
      if (design.motionIssue) {
        measurement.report.checks.push({ code: 'assembly_motion_unavailable', severity: 'warning', message: design.motionIssue })
        if (measurement.report.status === 'ok') measurement.report.status = 'review'
      }
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


  const printRay = new THREE.Raycaster(), printPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  function printPoint(event) {
    const rect = renderer.domElement.getBoundingClientRect()
    printRay.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera)
    return printRay.ray.intersectPlane(printPlane, new THREE.Vector3())
  }
  function printDown(event) {
    if (activity.mode !== 'idle' || !printPreview || printDrag || event.button !== 0) return
    const point = printPoint(event)
    const hit = printRay.intersectObjects(printPreview.root.children.filter(node => node.visible), true)[0]
    if (!hit || !point) return
    let node = hit.object
    while (node && !node.userData.printPart) node = node.parent
    if (!node) return
    printSelected = node.userData.printPart
    const placement = printLayout.parts.find(part => part.id === printSelected)
    printDrag = { pointerId: event.pointerId, origin: point, position: [...placement.position], previous: structuredClone(printLayout) }
    controls.enabled = false
    renderer.domElement.setPointerCapture(event.pointerId)
    event.stopImmediatePropagation(); publishPrint()
  }
  function printMove(event) {
    if (!printDrag || event.pointerId !== printDrag.pointerId) return
    const point = printPoint(event)
    if (!point) return
    const placement = printLayout.parts.find(part => part.id === printSelected)
    placement.position = [printDrag.position[0] + point.x - printDrag.origin.x, printDrag.position[1] + point.y - printDrag.origin.y]
    if (printFrame === null) printFrame = requestAnimationFrame(() => {
      printFrame = null
      if (!closed && printPreview) drawPrint()
    })
    event.stopImmediatePropagation()
  }
  function printUp(event) {
    if (!printDrag || event.pointerId !== printDrag.pointerId) return
    if (printFrame !== null) cancelAnimationFrame(printFrame)
    printFrame = null
    if (event.type !== 'pointerup') printLayout = printDrag.previous
    else { printUndo.push(printDrag.previous); if (printUndo.length > 32) printUndo.shift() }
    printDrag = null; controls.enabled = true
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
    drawPrint(); publishPrint(); event.stopImmediatePropagation()
  }
  const printListeners = [['pointerdown', printDown], ['pointermove', printMove], ['pointerup', printUp], ['pointercancel', printUp], ['lostpointercapture', printUp]]
  for (const [name, listener] of printListeners) renderer.domElement.addEventListener(name, listener, true)

  return {
    /** Set the visible work phase and stop any in-flight placement drag before locking edits. */
    setActivity(mode) {
      if (mode !== 'idle' && printDrag) printUp({ type: 'pointercancel', pointerId: printDrag.pointerId, stopImmediatePropagation() {} })
      activity.setMode(mode)
    },
    /** Enter a print-only preview; an absent saved layout creates deterministic placement. */
    openPrintLayout(saved, options) {
      if (activity.mode !== 'idle' || !design || designUrl !== designSpec?.url || shapeDeformer || objects.size) throw new Error('Load a canonical model and finish editing before arranging')
      clearMotion(); syncHighlight(); showOverlay(false)
      try {
        if (!printableParts) printableParts = printParts(design)
        const identity = printLayoutIdentity(designSpec, options.volume)
        const candidate = saved ?? printLayout ?? arrangePrintParts(printableParts, { ...options, identity })
        if (candidate.identity !== identity) throw new Error('Print layout belongs to another model revision')
        const next = createPrintPreview(printableParts, scene, solidMaterial.color)
        try { next.apply(candidate, printPlate) } catch (error) { next.dispose(); throw error }
        printPreview?.dispose(); printPreview = next; printLayout = structuredClone(candidate)
        printSelected = printLayout.parts[0].id; designRoot.visible = false
        clearVolume(); buildVolume(options.volume)
        hover.clear(); frame(); drawPrint(); publishPrint()
        return printSnapshot()
      } catch (error) { highlightOverlay?.resume(); showMotion(); syncHighlight(); render(); throw error }
    },
    closePrintLayout() { clearPrint(); showMotion(); updateGridBounds(); syncHighlight(); render() },
    printLayoutState: printSnapshot,
    selectPrintPart(id) { printSelected = id; printPlate = printLayout.parts.find(part => part.id === id).plate; drawPrint(); publishPrint() },
    selectPrintPlate(plate) { printPlate = plate; printSelected = printLayout.parts.find(part => part.plate === plate)?.id ?? printSelected; drawPrint(); publishPrint() },
    editPrintPart(change) {
      if (activity.mode !== 'idle' || !printPreview || !printSelected) return
      const next = structuredClone(printLayout), part = next.parts.find(part => part.id === printSelected)
      if (change.move) part.position = part.position.map((n, i) => n + change.move[i])
      if (change.rotate !== undefined) part.rotation[change.rotate] = (part.rotation[change.rotate] + 90) % 360
      if (change.plate !== undefined) { part.plate = change.plate; printPlate = change.plate }
      printPreview.apply(next, printPlate, printSelected)
      printUndo.push(printLayout); if (printUndo.length > 32) printUndo.shift()
      printLayout = next; render(); publishPrint()
    },
    rearrangePrintParts(options) {
      if (activity.mode !== 'idle') return
      const next = arrangePrintParts(printableParts, { ...options, identity: printLayout.identity })
      printUndo.push(printLayout); if (printUndo.length > 32) printUndo.shift()
      printLayout = next; printPlate = 0; drawPrint(); publishPrint()
    },
    undoPrintLayout() { if (activity.mode === 'idle' && printUndo.length) { printLayout = printUndo.pop(); printPlate = 0; drawPrint(); publishPrint() } },
    exportPrintPlate() { if (activity.mode !== 'idle') throw new Error('Model work is in progress'); return printPreview.exportPlate() },
    /** Effective parameters of the successfully loaded model, including defaults. */
    modelParameters() { return { ...design?.parameters } },
    /** Movement is a local pose; it never changes saved parameters or validation inputs. */
    motionControls() { return motion ? { ...motion, id: designUrl } : null },
    /**
     * Publish handle positions in viewport percentages and viewport width in CSS pixels.
     * @param {string} id Loaded design URL.
     * @param {Function} draw Receives handle positions and viewport width.
     * @param {Function} [onCanvasClick] Receives a canvas click after the gesture ends.
     * @returns {Function} Dispose the subscription.
     */
    observeMotionAnchors(id, draw, onCanvasClick) {
      const subscription = { id, draw, onCanvasClick }
      motionOverlay = subscription
      drawMotionOverlay()
      return () => {
        if (motionOverlay !== subscription) return
        motionOverlay = null
        motionProjection.owner = null
      }
    },
    /** Return the physical display unit for an active movement axis. */
    motionUnit(key) { return design?.motionUnit?.(key) },
    updateMotion(values, { id = designUrl, deferDraw = false } = {}) {
      if (activity.mode !== 'idle' || id !== designUrl || !motion || shapeDeformer || printPreview) return false
      const next = controlValues(motion, values), previous = motion.values
      const pin = hover.snapshot({ pinnedOnly: true })
      const saved = pin?.object && (motionPreview?.savedHit(pin.object, pin.point)
        ?? { node: pin.object, point: designRoot.worldToLocal(pin.point.clone()) })
      motion.values = next
      try { showMotion() } catch (error) { motion.values = previous; throw error }
      updateGridBounds()
      poses.delete(designSpec.path); poses.set(designSpec.path, { values: { ...next }, identity: design.poseIdentity ?? null })
      if (poses.size > 32) poses.delete(poses.keys().next().value)
      const relocated = saved && (motionPreview
        ? motionPreview.posedHit(saved.node, saved.point)
        : { object: saved.node, point: designRoot.localToWorld(saved.point) })
      const nextPin = relocated ? { ...pin, ...relocated } : pin?.named && !pin.object ? pin : null
      hover.replacePin(nextPin)
      if (nextPin?.named) updateNamedHit(nextPin, true)
      syncHighlight()
      if (!deferDraw) render()
      else if (motionFrame === null) motionFrame = requestAnimationFrame(() => { motionFrame = null; render() })
      return true
    },
    async applyShape(spec) {
      if (spec && printPreview) clearPrint()
      if (!spec) { clearShape(); showMotion(); syncHighlight(); render(); return null }
      clearMotion()
      if (!design) throw new Error('Load the model before its shape controls')
      if (spec.id !== shapeId) {
        clearShape(); hover.clear(); syncHighlight()
        shapeDeformer = spec.operation === 'fields' ? createFieldPreview(design.root, spec) : spec.operation === 'parameters' ? createParameterPreview(designRoot, design, spec) : spec.operation === 'surface' ? createSurfacePreview(design.root, spec) : createShapeDeformer(design.root, spec); shapeId = spec.id
        shapeOperation = spec.operation
        shapeMetrics.frames = 0; shapeMetrics.maxInputToDrawMs = 0; shapeMetrics.lastDrawMs = 0
      }
      shapeDeformer.setGuideVisible?.(!spec.frozen && highlightVisible)
      const owner = shapeDeformer
      const updated = await track(Promise.resolve(owner.update(spec.values)))
      if (closed || owner !== shapeDeformer || updated === false) return null
      render()
      return document.hidden ? null : shapeId
    },
    updateShape(values) {
      if (activity.mode !== 'idle') return false
      if (!shapeDeformer) return
      if (shapeOperation === 'parameters') {
        const owner = shapeDeformer
        return track(owner.update(values).then(updated => {
          if (closed || owner !== shapeDeformer || !updated) return false
          hover.replacePin(null)
          render(); return true
        }))
      }
      shapeValues = values; inputTime = performance.now()
      if (shapeFrame !== null) return
      shapeFrame = requestAnimationFrame(() => {
        shapeFrame = null
        if (!shapeDeformer || closed) return
        const started = performance.now()
        shapeDeformer.update(shapeValues)
        hover.replacePin(null)
        render()
        shapeMetrics.frames++; shapeMetrics.lastDrawMs = performance.now() - started
        shapeMetrics.maxInputToDrawMs = Math.max(shapeMetrics.maxInputToDrawMs, performance.now() - inputTime)
      })
    },
    shapeMetrics: () => ({ ...shapeMetrics }),
    /** The highlight drawn by the visible viewport, or null when it cannot be acknowledged. */
    renderedHighlight() {
      return !closed && !printPreview && !document.hidden && highlightVisible && designUrl === designSpec?.url
        && (!namedAgent || namedAgent.root.visible) ? highlightId : null
    },
    /** Report a deliberate overlay suppression so the host can settle the request. */
    highlightBlockedBy() {
      if (printPreview) return 'print_layout'
      if (!highlightVisible) return 'highlight_hidden'
      if (designSpec?.highlight?.regionId && (!namedAgent || shapeDeformer)) return 'region_unavailable'
      return null
    },
    /** Capture a pin from the mounted preview, or sample hover in a visible viewer. */
    captureCursor() {
      if (closed) return { status: 'viewer_unavailable', reason: 'viewer_closed' }
      if (shapeDeformer) return { status: 'viewer_unavailable', reason: 'temporary_edit' }
      if (printPreview) return { status: 'viewer_unavailable', reason: 'print_layout' }
      const hidden = document.hidden
      if (design && designUrl !== designSpec?.url) return { status: 'stale_view' }
      const hit = hover.snapshot({ pinnedOnly: hidden })
      if (!hit) return hidden ? { status: 'viewer_unavailable', reason: 'viewer_hidden' } : { status: 'no_hit' }
      const designIdentity = design ? {
        path: designSpec.path, revision: designSpec.revision, url: designUrl, transform: designSpec.transform,
      } : null
      let mesh = hit.named ? {} : { meshUnavailable: 'unsupported_model' }
      let region = null
      if (hit.object) {
        const savedHit = motionPreview?.savedHit(hit.object, hit.point)
        const savedNode = savedHit?.node ?? hit.object
        let object = savedNode, objectId = null, path = []
        while (object && object !== designRoot && object !== scene) {
          if (!object.userData.rumiCoordinateFrame) path.unshift(object.name || `child[${object.parent ? object.parent.children.indexOf(object) : 0}]`)
          for (const [id, entry] of objects) if (entry.mesh === object) objectId = id
          object = object.parent
        }
        const selection = hit.named ? undefined : { partPath: path, surfaceId: hit.surfaceId, mode: ['patch', 'surface', 'part', 'edge'][hit.mode] }
        let modelLocalBlob = null
        if (object === designRoot) {
          const center = savedHit ? savedHit.point.toArray() : designRoot.worldToLocal(hit.point.clone()).toArray()
          const radius = hit.radius / Math.abs(designRoot.getWorldScale(new THREE.Vector3()).x)
          modelLocalBlob = { center, radii: [radius, radius, radius], rotationDegrees: [0, 0, 0] }
          if (selection) {
            try { mesh = cursorMeshSnapshot(hit, savedNode, designRoot, selection.mode) }
            catch (error) { mesh = { meshUnavailable: 'geometry_unavailable' }; console.warn('Cursor mesh extraction failed', error) }
          }
        }
        region = { objectId, partPath: path, faceIndex: hit.faceIndex, worldPoint: hit.point.toArray(), worldRadius: hit.radius,
          modelLocalPoint: modelLocalBlob?.center ?? null, modelLocalBlob, ...(selection ? { selection } : {}) }
      }
      if (hit.named) {
        try { mesh = namedRegionMesh(hit.named, designRoot) }
        catch (error) { mesh = { meshUnavailable: 'geometry_unavailable' }; console.warn('Named surface mesh extraction failed', error) }
      }
      const size = renderer.getSize(new THREE.Vector2())
      const ratio = renderer.getPixelRatio()
      const longest = Math.max(size.x, size.y, 1)
      const resolution = Math.min(1600, longest * 2)
      let image
      try {
        renderer.setPixelRatio(1)
        for (const limit of new Set([resolution, Math.min(resolution, 960), Math.min(resolution, 640)])) {
          const factor = limit / longest
          renderer.setSize(Math.max(1, Math.round(size.x * factor)), Math.max(1, Math.round(size.y * factor)), false)
          renderer.render(scene, camera)
          image = renderer.domElement.toDataURL('image/png')
          if (image.length <= MAX_CURSOR_IMAGE_CHARS) break
        }
      } finally {
        renderer.setPixelRatio(ratio)
        renderer.setSize(size.x, size.y, false)
        render()
      }
      if (image.length > MAX_CURSOR_IMAGE_CHARS) return { status: 'capture_failed' }
      return {
        status: 'captured', capturedAt: new Date().toISOString(),
        identity: { sceneRevision, design: designIdentity },
        region, ...(hit.named ? { namedRegion: { id: hit.named.region.id, name: hit.named.region.name, regionMapKey: namedMap.key } } : {}),
        camera: { position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), fov: camera.getEffectiveFOV(), aspect: camera.aspect },
        image, ...mesh,
      }
    },
    /** Change the cursor scope at the pinned point or the next pointer hit. */
    setCursorMode(mode) { hover.setMode(mode) },
    /** Report surface selectors that could not be drawn for the loaded map. */
    regionResolution() {
      return { key: namedMap?.key ?? null, unresolvedIds: namedMap?.regions.filter(region => region.location.kind === 'surface' && !namedIndex?.get(region.id)).map(region => region.id) ?? [] }
    },
    /** Reveal a named region for keyboard focus and retain its existing mouse or touch state. */
    setRegionFocused(focused) { regionFocused = focused; render() },
    /** Set local presentation visibility without confirming the proposed region. */
    setHighlightVisible(visible) {
      highlightVisible = visible
      shapeDeformer?.setGuideVisible?.(visible && !designSpec?.analog?.frozen)
      showOverlay(visible)
      render()
    },
    /** Capture a studio-lit 1440 × 960 PNG using the loaded geometry and restore the interactive viewport. */
    thumbnail() {
      if (closed || shapeDeformer || printPreview || (objects.size === 0 && !design)) return null
      const bounds = previewBounds()
      if (bounds.isEmpty()) return null
      const coverCamera = frameCover(bounds)
      const size = renderer.getSize(new THREE.Vector2())
      const ratio = renderer.getPixelRatio()
      const overlayVisible = highlightVisible
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
        showOverlay(overlayVisible)
        if (namedCursor) namedCursor.root.visible = cursorVisible
        volumeNodes.forEach((node, index) => { node.visible = visibility[index] })
        scene.remove(coverCamera)
        light.visible = lightVisible
        renderer.setPixelRatio(ratio)
        renderer.setSize(size.x, size.y, false)
        render()
      }
    },
    async applyDesign(spec, volume) {
      if (closed) return null
      const mapChanged = designSpec?.regionMap?.key !== spec?.regionMap?.key
      if (designSpec?.url !== spec?.url || JSON.stringify(designSpec?.transform) !== JSON.stringify(spec?.transform)) {
        hover.clear()
      }
      if (printLayout && (!spec || spec.url !== designUrl || printLayout.identity !== printLayoutIdentity(spec, volume ?? printLayout.volume))) clearPrint(true)
      designSpec = spec
      designVolume = volume
      if (mapChanged && hover.mode.value === 4) hover.clear()
      if (!spec) {
        generation++
        clearShape(); clearMotion(); clearHighlight()
        if (design) { designRoot.remove(design.root); clearShape(); disposeDesign(design) }
        measurement = null; design = null; motion = null; designUrl = null; requestedUrl = null; requestedRenderRequest = null
        updateGridBounds()
        updateNamedIndex()
        render()
        return null
      }
      if (designUrl === spec.url) return placeDesign()
      if (requestedUrl === spec.url && requestedRenderRequest === spec.renderRequest) return designPending
      syncHighlight()
      render()
      requestedUrl = spec.url
      requestedRenderRequest = spec.renderRequest
      const request = ++generation
      designPending = track((async () => {
        try {
          const artifact = await artifacts.resolve(spec)
          if (closed || request !== generation) return null
          const release = artifact.retain()
          let next
          try {
            next = await parseUsdModel(artifact.bytes)
            next = { ...next, parameters: { ...artifact.parameters, ...next.parameters }, generate: artifact.generate, release }
            const retained = poses.get(spec.path)
            next.motion = readMotion(next.motionDefinitions, next.parameters, retained?.identity === next.poseIdentity ? retained?.values ?? {} : {})
            placeMesh(next.positions, spec.transform)
          } catch (error) { if (next) disposeModel(next.root); release(); throw error }
          if (closed || request !== generation) { disposeDesign(next); return null }
          // Validate placement before replacing the last successful design.
          clearShape(); clearMotion(); clearHighlight()
          if (design) {
            hover.clear()
            designRoot.remove(design.root); disposeDesign(design)
          }
          design = next
          motion = next.motion ?? null
          designUrl = spec.url
          designRoot.add(next.root)
          return placeDesign()
        } catch (error) {
          if (closed || request !== generation) return null
          throw error
        }
      })())
      return designPending
    },
    apply(view) {
      const request = ++sceneGeneration
      return track((async () => {
        if (closed) return
        const loaded = new Map()
        try {
          for (const spec of view.objects) {
            if (geometries.has(spec.datablockId) || loaded.has(spec.datablockId)) continue
            const model = await parseUsdModel(await generateStl(spec.positions))
            loaded.set(spec.datablockId, model)
            if (closed || request !== sceneGeneration) return
          }
          if (closed || request !== sceneGeneration) return
          for (const [id, model] of loaded) geometries.set(id, model)
          loaded.clear()
          if (sceneRevision !== view.revision) hover.clear()
          sceneRevision = view.revision
          const live = new Set()
          for (const spec of view.objects) {
            live.add(spec.id)
            const model = geometries.get(spec.datablockId)
            const material = spec.blocked ? blockedMaterial : solidMaterial
            let entry = objects.get(spec.id)
            if (!entry) {
              const mesh = new THREE.Group()
              mesh.matrixAutoUpdate = false; scene.add(mesh)
              entry = { mesh, datablockId: null }; objects.set(spec.id, entry)
            }
            const replace = entry.datablockId !== spec.datablockId
            const rebuildOverlay = !entry.overlay || entry.sourceMaterial !== material || replace
            if (rebuildOverlay) entry.overlay?.dispose()
            if (replace) {
              entry.mesh.clear(); entry.mesh.add(model.root.clone(true)); entry.datablockId = spec.datablockId
            }
            if (rebuildOverlay) {
              entry.mesh.traverse(node => { if (node.isMesh) node.material = material })
              entry.sourceMaterial = material
            }
            entry.mesh.matrix.fromArray(spec.matrix); entry.mesh.updateMatrixWorld(true)
            if (rebuildOverlay) entry.overlay = createHighlight(entry.mesh, { blobs: [] }, hover, activity.uniform, editPicker.active)
          }
          for (const [id, entry] of objects) {
            if (live.has(id)) continue
            entry.overlay.dispose(); scene.remove(entry.mesh); objects.delete(id)
          }
          const liveDatablocks = new Set([...objects.values()].map(entry => entry.datablockId))
          for (const [id, model] of geometries) {
            if (liveDatablocks.has(id)) continue
            disposeModel(model.root); geometries.delete(id)
          }
          const key = view.volume === null ? 'none' : `${view.volume.x},${view.volume.y},${view.volume.z}`
          if (!printPreview && key !== volumeKey) {
            clearVolume()
            if (view.volume !== null) buildVolume(view.volume)
            volumeKey = key
          }
          if (!framed && (objects.size > 0 || design !== null) && renderer.domElement.width > 0) { framed = true; frame() }
          else updateGridBounds()
          render()
        } finally { for (const model of loaded.values()) disposeModel(model.root) }
      })())
    },
    dispose() {
      if (closed) return Promise.allSettled([...tasks])
      closed = true
      if (motionFrame !== null) cancelAnimationFrame(motionFrame)
      motionOverlay = null
      motionProjection.owner = null
      activity.dispose()
      clearPrint(true, false); clearShape(); clearMotion(); poses.clear()
      generation++
      for (const [name, listener] of printListeners) renderer.domElement.removeEventListener(name, listener, true)
      hover.dispose()
      editPicker.dispose()
      updateNamedHit(null)
      namedIndex = null; namedMap = null; namedDesign = null
      clearHighlight()
      if (design) { clearShape(); disposeDesign(design) }
      design = null
      measurement = null
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      for (const entry of objects.values()) entry.overlay.dispose()
      for (const model of geometries.values()) disposeModel(model.root)
      geometries.clear()
      objects.clear()
      clearVolume()
      solidMaterial.dispose()
      blockedMaterial.dispose()
      grid.dispose()
      environment.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      return Promise.allSettled([...tasks, ...(!sharedArtifacts ? [artifacts.dispose()] : [])])
    },
  }
}
