/** Model-local Gaussian regions used only for visual clarification. */

/**
 * Validate tool JSON before replacing a highlight; failures preserve the previous region.
 * @param {object} value - Label and up to eight ellipsoids in model-local millimetres.
 * @returns {object} Detached, validated highlight fields.
 */
export function normalizeHighlight(value) {
  if (typeof value.label !== 'string' || value.label.length > 200 || (value.blobs?.length && !value.label.trim())) {
    throw new Error('Highlight label must describe the region in 1–200 characters')
  }
  if (!Array.isArray(value.blobs) || value.blobs.length > 8) throw new Error('Supply at most eight highlight blobs, or an empty array to clear')
  const vector = (value, positive) => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(number => Number.isFinite(number)
      && Math.abs(number) <= 1_000_000 && (!positive || number >= 0.001))) {
      throw new Error('Blob vectors require three finite numbers within ±1000000; radii must be at least 0.001 mm')
    }
    return [...value]
  }
  return { label: value.label.trim(), blobs: value.blobs.map(blob => ({
    center: vector(blob.center, false), radii: vector(blob.radii, true), rotationDegrees: vector(blob.rotationDegrees, false),
  })) }
}
