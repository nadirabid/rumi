/** Modeling adapters produce static GLB artifacts; their construction objects never enter the display scene. */
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { buildModel, disposeModel } from '../viewport/model.js'
import { normalizeControls, parameterValues } from '../analog/control-spec.js'
import { withMechanismMetadata } from '../mechanics.js'
import { validateGlb } from '../glb.js'

/** Export an owned millimetre/Z-up model and release it, including on failure. @param {object} model Built construction geometry. @param {object} metadata Asset extras. @returns {Promise<ArrayBuffer>} Self-contained GLB in metres/Y up. */
async function exportModel(model, metadata) {
  try {
    const scene = new THREE.Scene(), frame = new THREE.Group()
    frame.userData.rumiCoordinateFrame = true
    frame.rotation.x = -Math.PI / 2; frame.scale.setScalar(.001)
    frame.add(model.root); scene.add(frame)
    const bytes = withMechanismMetadata(await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true }), metadata)
    validateGlb(new Uint8Array(bytes))
    return bytes
  } finally { disposeModel(model.root) }
}

/** Generate a GLB from an already imported modeling module. @param {object} module Project generator. @param {object} saved Saved or preview parameter overrides. @returns {Promise<object>} GLB bytes and effective parameters. */
export async function generateModule(module, saved) {
  const defaults = parameterValues(module.parameters ?? {}), overrides = parameterValues(saved)
  if (Object.keys(overrides).some(key => !Object.hasOwn(defaults, key))) throw new Error('Saved parameters must exist in the model')
  const parameters = { ...defaults, ...overrides }, model = buildModel(module.build, parameters)
  let ranges = [], labels = []
  if (module.motionControls !== undefined && !(Array.isArray(module.motionControls) && !module.motionControls.length)) {
    try {
      const controls = normalizeControls(module.motionControls, parameters)
      ranges = controls.flatMap(control => control.axes.map(axis => ({ key: axis.key,
        range: [axis.min - parameters[axis.key], axis.max - parameters[axis.key]], origin: parameters[axis.key] })))
      labels = controls.flatMap(control => control.axes.map(axis => ({ key: axis.key,
        label: control.axes.length === 1 ? control.label : `${control.label}: ${axis.key}` })))
    } catch (_error) { ranges = [null] /* Invalid declarations remain visible to mechanical validation. */ }
  }
  const bytes = await exportModel(model, {
    ...(module.assembly === undefined ? {} : { rumiAssembly: module.assembly }),
    ...(module.mechanisms === undefined ? {} : { rumiMechanisms: module.mechanisms }),
    ...(module.motionControls === undefined ? {} : { rumiMotionKeys: ranges.map(item => item?.key ?? null), rumiMotionRanges: ranges, rumiMotionLabels: labels }),
  })
  return { bytes, parameters }
}

/** Convert imported STL triangles into the same display artifact as other models. @param {Float32Array} positions Canonical millimetre/Z-up triangles. @returns {Promise<ArrayBuffer>} Static GLB preserving every triangle. */
export function generateStl(positions) {
  const model = buildModel(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3)); geometry.computeVertexNormals()
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
    mesh.name = 'Imported mesh'
    return mesh
  })
  return exportModel(model, {})
}
