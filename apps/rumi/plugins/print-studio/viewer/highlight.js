/** Cursor selection validation at the renderer boundary. */

/**
 * Validate a revision-specific surface reference from a cursor snapshot.
 * @param {object} value - Path, surface id and selection scope from a cursor capture.
 * @returns {object} Detached selection reference.
 */
export function normalizeSelection(value) {
  if (!value || !Array.isArray(value.partPath) || !value.partPath.length || value.partPath.length > 128
    || !value.partPath.every(part => typeof part === 'string' && part.length <= 1000)
    || !Number.isSafeInteger(value.surfaceId) || value.surfaceId < 1 || value.surfaceId > 200000
    || !['patch', 'surface', 'part', 'edge'].includes(value.mode)) throw new Error('Invalid cursor surface selection')
  return { partPath: [...value.partPath], surfaceId: value.surfaceId, mode: value.mode }
}
