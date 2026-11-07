/** Build exact JavaScript snapshots for host validation without changing the displayed model. */
import { buildModel, disposeModel } from './model.js'
import { parameterValues } from '../analog/control-spec.js'
import { encodeStl } from '../stl.js'

/**
 * Export one immutable source snapshot; release every constructed GPU resource.
 * @param {object} request Snapshot URL and saved parameter values.
 * @returns {Promise<ArrayBuffer>} Binary STL in model-local millimetres, Z up.
 */
export async function validationMesh(request) {
  const module = await import(/* @vite-ignore */ request.url)
  const parameters = { ...parameterValues(module.parameters ?? {}), ...parameterValues(request.parameters) }
  const model = buildModel(module.build, parameters)
  try { return encodeStl(model.positions) }
  finally { disposeModel(model.root) }
}
