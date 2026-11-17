/** Isolated comparison renders; never mutates the person's viewport or live controls. */
import * as THREE from 'three'
import { parseUsdModel } from '../viewport/usd.js'
import { disposeModel } from '../viewport/model.js'
import { createFieldPreview } from './field-preview.js'
import { createSurfacePreview } from './surface.js'
import { createShapeDeformer } from './gpu.js'
import { measureControlCase } from './evidence.js'

const SIZE = 300
const HEAT_MM = 20
const VIEWS = [[0, -1, .12], [1, 0, .12], [.7, 1, .4]]

/** Choose the preview adapter that owns the recipe. @param {object} root Saved model. @param {object} spec Validated recipe. @returns {object} Preview with update and dispose. */
export function createSpecPreview(root, spec) {
  if (spec.operation === 'fields') return createFieldPreview(root, spec)
  if (spec.operation === 'surface') return createSurfacePreview(root, spec)
  return createShapeDeformer(root, spec)
}

/** Render comparisons using the viewer adapters. @param {ArrayBuffer} bytes Saved USD. @param {object} request Source-bound cases. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Neutral check, measurements, and PNG comparisons. */
export async function renderControlEvidence(bytes, request, signal) {
  signal.throwIfAborted()
  const model = await parseUsdModel(bytes)
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true, preserveDrawingBuffer: true })
    renderer.setSize(SIZE, SIZE); renderer.setPixelRatio(1)
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf4f4f4)
    scene.add(model.root, new THREE.HemisphereLight(0xffffff, 0x777777, 2))
    const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(1, -2, 3); scene.add(light)
    // Fit one camera volume across all cases; never reframe a before/after pair.
    const bounds = new THREE.Box3().setFromObject(model.root)
    const neutral = request.spec.operation === 'cut' ? null : measureControlCase(model.root, request.spec, { baseline: null, values: request.neutral }).metrics
    if (neutral && neutral.maxDisplacementMm > .001) throw new Error('Neutral controls change the saved mesh')
    for (const test of request.cases) {
      signal.throwIfAborted()
      const measured = measureControlCase(model.root, request.spec, test)
      for (const mesh of measured.meshes) for (const point of mesh.points) bounds.expandByPoint(new THREE.Vector3(...point))
      await scheduler.yield()
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere()), extent = Math.max(sphere.radius * 1.12, 1)
    const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, .01, extent * 10)
    camera.up.set(0, 0, 1)
    const canvas = document.createElement('canvas'); canvas.width = SIZE * 3; canvas.height = SIZE * 3 + 100
    const pen = canvas.getContext('2d')
    if (!pen) throw new Error('Comparison canvas is unavailable')
    function drawColumn(column) {
      for (let row = 0; row < VIEWS.length; row++) {
        camera.position.copy(sphere.center).add(new THREE.Vector3(...VIEWS[row]).setLength(extent * 3))
        camera.lookAt(sphere.center); camera.updateProjectionMatrix()
        renderer.render(scene, camera)
        pen.drawImage(renderer.domElement, column * SIZE, row * SIZE + 100)
      }
    }
    function drawValues(values, column, original = false) {
      let preview
      try {
        if (!original) {
          preview = createSpecPreview(model.root, request.spec)
          preview.setGuideVisible?.(false); preview.update(values)
        }
        drawColumn(column)
      } finally { preview?.dispose() }
    }
    const results = []
    for (let index = 0; index < request.cases.length; index++) {
      signal.throwIfAborted()
      const test = request.cases[index], measured = measureControlCase(model.root, request.spec, test)
      pen.fillStyle = '#f4f4f4'; pen.fillRect(0, 0, canvas.width, canvas.height)
      pen.fillStyle = '#202020'; pen.font = '16px sans-serif'
      pen.fillText(test.id, 12, 22)
      pen.fillText(`Max movement ${measured.metrics.maxDisplacementMm.toFixed(3)} mm; affected ${(measured.metrics.affectedFraction * 100).toFixed(1)}%`, 12, 44)
      pen.fillText(request.spec.operation === 'cut' ? 'Heat: gray retained / red removed (shown on original)' : `Heat: gray <0.01 mm; gold → red ${HEAT_MM} mm; front / side / rear`, 12, 66)
      for (const [i, title] of ['Before', 'After', 'Change overlay'].entries()) pen.fillText(title, i * SIZE + 12, 90)
      drawValues(test.baseline, 0, request.spec.operation === 'cut')
      drawValues(test.values, 1)
      const owned = []
      try {
        for (const mesh of measured.meshes) {
          const node = mesh.node, geometry = node.geometry.clone(), colors = [], positions = geometry.getAttribute('position')
          const inverse = node.matrixWorld.clone().invert()
          for (let i = 0; i < mesh.points.length; i++) {
            const p = new THREE.Vector3(...mesh.points[i]).applyMatrix4(inverse)
            positions.setXYZ(i, p.x, p.y, p.z)
            const color = mesh.distances[i] < .01 ? new THREE.Color(0x999999)
              : new THREE.Color(0xffd78a).lerp(new THREE.Color(0xe02020), Math.min(1, mesh.distances[i] / (request.spec.operation === 'cut' ? 1 : HEAT_MM)))
            colors.push(color.r, color.g, color.b)
          }
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeVertexNormals(); geometry.computeBoundingSphere()
          const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, metalness: 0, side: THREE.DoubleSide })
          owned.push({ node, geometry: node.geometry, material: node.material, nextGeometry: geometry, nextMaterial: material })
          node.geometry = geometry; node.material = material
        }
        drawColumn(2)
      } finally {
        for (const item of owned) { item.node.geometry = item.geometry; item.node.material = item.material; item.nextGeometry.dispose(); item.nextMaterial.dispose() }
      }
      results.push({ id: test.id, ...measured.metrics, image: canvas.toDataURL('image/png') })
      // Task continuations allow cancellation without waiting for throttled background timers.
      await scheduler.yield()
    }
    signal.throwIfAborted()
    return { status: 'complete', neutralMaxDisplacementMm: neutral?.maxDisplacementMm ?? null, cases: results }
  } finally { renderer?.dispose(); renderer?.forceContextLoss(); disposeModel(model.root) }
}
