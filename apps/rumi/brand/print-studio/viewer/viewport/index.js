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
import { createHover } from './hover.js'
import { createHighlight } from './highlight.js'
import { disposeModel } from './model.js'
import { placeMesh } from '../transform.js'
import { analyzeMesh } from '../checks.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

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
 * @param {object} [sharedArtifacts] Client-owned saved GLBs shared with validation.
 * @returns {object} The owned viewport. `apply(view)` reconciles STL objects;
 * `applyDesign(spec, volume)` loads a source revision and resolves to measured
 * geometry. Stale loads resolve to null; build failures reject and retain the
 * previous design. `dispose()` releases the viewport and invalidates imports.
 */
export function createViewport(element, onFailure, onCursorMode = () => {}, sharedArtifacts) {
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
  const poses = new Map()
  function clearMotion() { if (motionPreview) clearHighlight(); motionPreview?.dispose(); motionPreview = null }
  function showMotion() {
    if (!motion || !design || shapeDeformer) return
    if (Object.entries(motion.values).every(([key, value]) => design.parameters[key] === value)) { clearMotion(); return }
    if (!motionPreview) {
      clearHighlight()
      motionPreview = design.createMotionPreview(designRoot)
    }
    motionPreview.update(motion.values)
  }
  const shapeMetrics = { frames: 0, maxInputToDrawMs: 0, lastDrawMs: 0 }
  function clearShape() { if (shapeFrame !== null) cancelAnimationFrame(shapeFrame); shapeFrame = null; if (shapeDeformer) track(Promise.resolve(shapeDeformer.dispose())); shapeDeformer = null; shapeId = null; shapeOperation = null }
  let highlightOverlay = null, highlightId = null, highlightVisible = true
  let design = null, designUrl = null, requestedUrl = null, generation = 0, cameraCommand = null
  let sceneRevision = 0, sceneGeneration = 0
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

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.domElement.setAttribute('aria-hidden', 'true')
  element.appendChild(renderer.domElement)
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000)
  camera.up.set(0, 0, 1)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
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

  const hover = createHover(renderer.domElement, camera,
    () => shapeDeformer ? [] : [...objects.values()].map(entry => entry.mesh).concat(design ? [designRoot] : []), render, onCursorMode)
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
    const highlight = !motionPreview && designUrl === designSpec?.url ? designSpec?.highlight : null
    if (highlightOverlay && highlightId === (highlight?.id ?? null)) return
    if (!design) { clearHighlight(); return }
    if (highlightOverlay) highlightOverlay.update(highlight ?? { blobs: [] })
    else highlightOverlay = createHighlight(motionPreview?.root ?? design.root, highlight ?? { blobs: [] }, hover)
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

  return {
    /** Effective parameters of the successfully loaded model, including defaults. */
    modelParameters() { return { ...design?.parameters } },
    /** Movement is a local pose; it never changes saved parameters or validation inputs. */
    motionControls() { return motion ? { ...motion, id: designUrl } : null },
    updateMotion(values) {
      if (!motion || shapeDeformer) return false
      const next = controlValues(motion, values), previous = motion.values
      motion.values = next
      try { showMotion() } catch (error) { motion.values = previous; throw error }
      poses.delete(designSpec.path); poses.set(designSpec.path, { values: { ...next }, identity: design.poseIdentity ?? null })
      if (poses.size > 32) poses.delete(poses.keys().next().value)
      hover.clear(); cursorAnchors.clear(); syncHighlight(); render()
      return true
    },
    async applyShape(spec) {
      if (!spec) { clearShape(); showMotion(); syncHighlight(); render(); return null }
      clearMotion()
      if (!design) throw new Error('Load the model before its shape controls')
      if (spec.id !== shapeId) {
        clearShape(); hover.clear(); syncHighlight()
        shapeDeformer = spec.operation === 'parameters' ? createParameterPreview(designRoot, design, spec) : createShapeDeformer(design.root, spec); shapeId = spec.id
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
      if (!shapeDeformer) return
      if (shapeOperation === 'parameters') {
        const owner = shapeDeformer
        return track(owner.update(values).then(updated => {
          if (closed || owner !== shapeDeformer || !updated) return false
          render(); return true
        }))
      }
      shapeValues = values; inputTime = performance.now()
      if (shapeFrame !== null) return
      shapeFrame = requestAnimationFrame(() => {
        shapeFrame = null
        if (!shapeDeformer || closed) return
        const started = performance.now(); shapeDeformer.update(shapeValues); render()
        shapeMetrics.frames++; shapeMetrics.lastDrawMs = performance.now() - started
        shapeMetrics.maxInputToDrawMs = Math.max(shapeMetrics.maxInputToDrawMs, performance.now() - inputTime)
      })
    },
    shapeMetrics: () => ({ ...shapeMetrics }),
    /** The highlight drawn by the visible viewport, or null when it cannot be acknowledged. */
    renderedHighlight() {
      return !closed && !document.hidden && highlightVisible && designUrl === designSpec?.url ? highlightId : null
    },
    /** Capture the live cursor region and current camera view; no previous hover is reused. */
    captureCursor(request = {}) {
      if (closed || document.hidden || shapeDeformer || motionPreview) return { status: 'viewer_unavailable' }
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
        if (!object.userData.rumiCoordinateFrame) path.unshift(object.name || `child[${object.parent ? object.parent.children.indexOf(object) : 0}]`)
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
      shapeDeformer?.setGuideVisible?.(visible && !designSpec?.analog?.frozen)
      if (highlightOverlay) highlightOverlay.setVisible(visible)
      render()
    },
    /** Capture a fitted 480 × 320 PNG using the loaded geometry; restore the interactive viewport. */
    thumbnail() {
      if (closed || shapeDeformer || (objects.size === 0 && !design)) return null
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
        clearShape(); clearMotion(); clearHighlight()
        if (design) { designRoot.remove(design.root); clearShape(); disposeDesign(design) }
        measurement = null; design = null; motion = null; designUrl = null; requestedUrl = null
        render()
        return null
      }
      if (designUrl === spec.url) return placeDesign()
      if (requestedUrl === spec.url) return designPending
      syncHighlight()
      render()
      requestedUrl = spec.url
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
          if (design) { designRoot.remove(design.root); clearShape(); disposeDesign(design) }
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
          if (sceneRevision !== view.revision) { hover.clear(); cursorAnchors.clear() }
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
            if (rebuildOverlay) entry.overlay = createHighlight(entry.mesh, { blobs: [] }, hover)
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
          if (key !== volumeKey) {
            clearVolume()
            if (view.volume !== null) buildVolume(view.volume)
            volumeKey = key
          }
          if (!framed && (objects.size > 0 || design !== null) && renderer.domElement.width > 0) { framed = true; frame() }
          render()
        } finally { for (const model of loaded.values()) disposeModel(model.root) }
      })())
    },
    dispose() {
      clearShape(); clearMotion(); poses.clear()
      if (closed) return Promise.allSettled([...tasks])
      closed = true
      generation++
      hover.dispose()
      cursorAnchors.clear()
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
      environment.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      return Promise.allSettled([...tasks, ...(!sharedArtifacts ? [artifacts.dispose()] : [])])
    },
  }
}
