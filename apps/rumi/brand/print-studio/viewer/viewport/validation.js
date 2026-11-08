/** Validation consumes the same saved GLB generation as display. */
import { createModelArtifacts } from '../generation/artifacts.js'

/** Export an immutable source through the common modeling adapter. @param {object} request Source URL and saved parameters. @returns {Promise<ArrayBuffer>} GLB bytes with physical-part metadata. */
export async function validationMesh(request) {
  const artifacts = createModelArtifacts()
  try { return (await artifacts.resolve(request)).bytes }
  finally { await artifacts.dispose() }
}
