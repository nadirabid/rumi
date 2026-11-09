/** Validation consumes the same saved USD generation as display. */
import { createModelArtifacts } from '../generation/artifacts.js'

/** Export an immutable source through the common modeling adapter. @param {object} request Source URL and saved parameters. @returns {Promise<ArrayBuffer>} USD bytes with physical-part declarations. */
export async function validationMesh(request) {
  const artifacts = createModelArtifacts()
  try { return (await artifacts.resolve(request)).bytes }
  finally { await artifacts.dispose() }
}
