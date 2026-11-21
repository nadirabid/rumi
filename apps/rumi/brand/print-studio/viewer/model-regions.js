/** Revision-bound names for model-local surface locations. */

const namePattern = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,64}$/u
const coordinate = n => Number.isFinite(n) && Math.abs(n) <= 1e6

/**
 * Validate the metadata saved beside a USD model.
 * @param {object} value Parsed region metadata.
 * @param {string} hash Hash of the displayed geometry.
 * @returns {object|null} Valid metadata, or null for another revision.
 */
export function readModelRegions(value, hash) {
  if (!value || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceHash)) throw new Error('Region map needs a USD SHA-256')
  if (value.sourceHash !== hash) return null
  const name = text => {
    if (typeof text !== 'string' || !namePattern.test(text.trim())) throw new Error('Supply a region name of up to 64 characters')
    return text.trim()
  }
  if (!Array.isArray(value.regions) || !value.regions.length || value.regions.length > 96) throw new Error('Supply between 1 and 96 named features')
  const ids = new Set(['remainder'])
  const regions = value.regions.map(region => {
    if (!region || typeof region.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(region.id) || ids.has(region.id)) throw new Error('Use a distinct lowercase ID for each region')
    ids.add(region.id)
    if (!Array.isArray(region.boxes) || !region.boxes.length || region.boxes.length > 16) throw new Error('Supply between 1 and 16 boxes for a region')
    const boxes = region.boxes.map(box => {
      if (!Array.isArray(box) || box.length !== 6 || !box.every(coordinate) || !box.slice(0, 3).every((n, i) => n < box[i + 3])) {
        throw new Error('A box needs minimum and maximum XYZ coordinates in millimetres')
      }
      return box
    })
    return { id: region.id, name: name(region.name), boxes }
  })
  return { regions, remainder: { id: 'remainder', name: name(value.remainder) } }
}

/**
 * Find a feature for a point on the model surface. Earlier, more specific features take priority.
 * @param {object} map A validated region map.
 * @param {number[]} point XYZ in saved model millimetres.
 * @returns {object} Named feature, including the named remainder.
 */
export function modelRegionAt(map, point) {
  const [x, y, z] = point
  return map.regions.find(region => region.boxes.some(([xmin, ymin, zmin, xmax, ymax, zmax]) =>
    x >= xmin && x <= xmax && y >= ymin && y <= ymax && z >= zmin && z <= zmax)) ?? map.remainder
}

/**
 * Identify a feature on one displayed source and one edition of its region map.
 * @param {object} design Current design, including its region map.
 * @param {string} id Feature ID from that map.
 * @returns {string} Reference for use by the browser and host.
 */
export function modelRegionReference(design, id) {
  return `${design.url}#${design.regionMap.key}/${id}`
}
