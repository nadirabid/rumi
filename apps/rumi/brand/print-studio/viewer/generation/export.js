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

/** Convert imported STL triangles into the same display artifact as other models. @param {Float32Array} positions Canonical millimetre/Z-up triangles. @returns {Promise<ArrayBuffer>} Static ASCII USD preserving every triangle. */
export function generateStl(positions) {
  if (!positions.length || positions.length % 9 || positions.some(value => !Number.isFinite(value))) throw new Error('STL requires finite triangles')
  const points = []
  for (let i = 0; i < positions.length; i += 3) points.push(`(${positions[i] / 1000}, ${positions[i + 1] / 1000}, ${positions[i + 2] / 1000})`)
  const text = `#usda 1.0
(
    defaultPrim = "Model"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Model" (
    prepend apiSchemas = ["IsaacRobotAPI", "PhysicsArticulationRootAPI"]
)
{
    rel isaac:physics:robotLinks = </Model/Imported_mesh>
    rel isaac:physics:robotJoints = None
    token rumi:manufacturingMode = "print-in-place"
    def Mesh "Imported_mesh" (
        prepend apiSchemas = ["IsaacLinkAPI", "PhysicsRigidBodyAPI", "PhysicsCollisionAPI"]
    )
    {
        point3f[] points = [${points.join(', ')}]
        int[] faceVertexCounts = [${Array(positions.length / 9).fill(3).join(', ')}]
        int[] faceVertexIndices = [${Array.from({ length: positions.length / 3 }, (_, i) => i).join(', ')}]
        uniform token subdivisionScheme = "none"
    }
}
`
  return Promise.resolve(new TextEncoder().encode(text).buffer)
}
