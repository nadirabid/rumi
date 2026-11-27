/** Manufacturing policy is independent of joint motion and retains legacy models for inspection. */

/** Report moving assemblies that require connector redesign before separate printing.
 * @param {object} assembly Validated assembly with physical connections and manufacturing intent.
 * @returns {object[]} Blocking policy findings; static models have no moving-part requirement.
 */
export function manufacturingChecks(assembly) {
  if (assembly.connections.some(connection => connection.kind !== 'fixed') && assembly.manufacturing.mode !== 'separate') {
    return [{ code: 'separate_printing_required', severity: 'error', count: 1,
      message: 'Moving parts must be printed separately and assembled afterward. Redesign captive connectors and publish with mode="separate"; changing the label alone does not make assembly possible.' }]
  }
  return []
}
