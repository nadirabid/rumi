/** Durable print placement contains no geometry; source identity prevents reuse after edits. */
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)

/** Parse a saved or submitted layout before using its transforms.
 * @param {object} value Untrusted JSON.
 * @returns {object} Version-one placement record.
 */
export function parsePrintLayout(value) {
  if (!value || value.version !== 1 || typeof value.identity !== 'string' || value.identity.length > 4096
    || !value.volume || !['x', 'y', 'z'].every(key => Number.isFinite(value.volume[key]) && value.volume[key] > 0 && value.volume[key] <= 2000)
    || !Number.isFinite(value.gap) || value.gap < 0 || value.gap > 50
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 128) throw new Error('Invalid print layout')
  const ids = new Set()
  for (const part of value.parts) {
    if (!part || typeof part.id !== 'string' || !part.id || part.id.length > 2048 || ids.has(part.id)
      || !Number.isInteger(part.plate) || part.plate < 0 || part.plate >= 128
      || !vector(part.rotation) || part.rotation.some(angle => angle % 90 !== 0 || Math.abs(angle) > 360)
      || !Array.isArray(part.position) || part.position.length !== 2 || !part.position.every(n => Number.isFinite(n) && Math.abs(n) <= 4000)) throw new Error('Invalid print part placement')
    ids.add(part.id)
  }
  return { version: 1, identity: value.identity, volume: { x: value.volume.x, y: value.volume.y, z: value.volume.z }, gap: value.gap,
    parts: value.parts.map(part => ({ id: part.id, plate: part.plate, position: [...part.position], rotation: [...part.rotation] })) }
}

/** Identify the saved geometry, scale and selected printer envelope.
 * @param {object} design Published source description.
 * @param {object} volume Resolved build dimensions.
 * @returns {string} Stable identity across app restarts.
 */
export function printLayoutIdentity(design, volume) {
  return JSON.stringify([design.path, design.contentHash, design.transform, volume])
}
