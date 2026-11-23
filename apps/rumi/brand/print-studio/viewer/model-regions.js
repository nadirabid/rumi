/** Revision-bound feature names, descriptions, and model-local geometry. */

/** @typedef {{partPath: string[], surfaceIds?: number[], faceRanges?: number[][]}} SurfacePart */
/** @typedef {{kind: 'surface', parts: SurfacePart[]} | {kind: 'curve', points: number[][], closed: boolean} | {kind: 'volume', boxes: number[][]} | {kind: 'point', point: number[]}} FeatureLocation */
/** @typedef {{id: string, name: string, parentId?: string, description?: string, aliases?: string[], location: FeatureLocation, boxes?: number[][]}} ModelFeature */
/** @typedef {{regions: ModelFeature[], remainder: {id: string, name: string}|null}} FeatureMap */

const textPattern = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u
const coordinate = n => Number.isFinite(n) && Math.abs(n) <= 1e6
const maxFaces = 200_000
const maxRegions = 256
/** A saved map can contain thousands of disjoint triangle ranges for one sculpted feature. */
export const MAX_REGION_MAP_BYTES = 2 * 1024 * 1024
const featureKey = value => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

function text(value, maxLength, error) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if ([...trimmed].length > maxLength || !textPattern.test(trimmed)) throw new Error(error)
  return trimmed
}

function name(value) {
  return text(value, 64, 'Supply a region name or alias of up to 64 characters')
}

function boundedArray(value, min, max) {
  return Array.isArray(value) && value.length >= min && value.length <= max
}

function boxes(value) {
  if (!boundedArray(value, 1, 16)) throw new Error('Supply between 1 and 16 boxes for a region')
  return value.map(box => {
    if (!boundedArray(box, 6, 6) || !box.every(coordinate) || !box.slice(0, 3).every((n, i) => n < box[i + 3])) {
      throw new Error('A box needs minimum and maximum XYZ coordinates in millimetres')
    }
    return [...box]
  })
}

function point(value) {
  if (!boundedArray(value, 3, 3) || !value.every(coordinate)) throw new Error('Supply XYZ coordinates in model-local millimetres')
  return [...value]
}

function part(value) {
  if (!boundedArray(value?.partPath, 1, 128) || !value.partPath.every(component => typeof component === 'string' && component.length > 0 && component.length <= 1000)) {
    throw new Error('Set partPath to the array of names returned by viewer_analyze_surfaces')
  }
  const { surfaceIds, faceRanges } = value
  if (surfaceIds !== undefined && (!boundedArray(surfaceIds, 1, maxFaces) || !surfaceIds.every(id => Number.isInteger(id) && id >= 1 && id <= maxFaces))) {
    throw new Error('Supply surfaceIds from the analyzed part')
  }
  if (faceRanges !== undefined && (!boundedArray(faceRanges, 1, maxFaces) || !faceRanges.every(range =>
    boundedArray(range, 2, 2) && range.every(Number.isInteger) && range[0] >= 0 && range[1] > range[0] && range[1] <= maxFaces))) {
    throw new Error('Supply faceRanges as [first triangle, end exclusive] pairs in the analyzed part')
  }
  const ranges = []
  for (const [start, end] of (faceRanges ?? []).toSorted((a, b) => a[0] - b[0])) {
    const previous = ranges.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else ranges.push([start, end])
  }
  return { partPath: [...value.partPath], ...(surfaceIds ? { surfaceIds: [...new Set(surfaceIds)] } : {}),
    ...(faceRanges ? { faceRanges: ranges } : {}) }
}

function location(value) {
  switch (value?.kind) {
    case 'surface': {
      if (!boundedArray(value.parts, 1, 32)) throw new Error('Supply between 1 and 32 parts for a surface region')
      const parts = value.parts.map(part)
      if (new Set(parts.map(part => JSON.stringify(part.partPath))).size !== parts.length) throw new Error('Supply one surface selector per part path')
      return { kind: 'surface', parts }
    }
    case 'curve': {
      const { closed, points } = value
      if (closed !== undefined && typeof closed !== 'boolean') throw new Error('Set closed to true or false for a curve')
      if (!boundedArray(points, closed ? 3 : 2, 128)) throw new Error('Supply up to 128 points and at least two points for an open curve or three for a closed curve')
      const vertices = points.map(point)
      if (vertices.some((vertex, i) => {
        const next = vertices[i + 1] ?? (closed ? vertices[0] : null)
        return next && vertex.every((coordinate, axis) => coordinate === next[axis])
      })) throw new Error('Use distinct consecutive points for a curve')
      return { kind: 'curve', points: vertices, closed: closed ?? false }
    }
    case 'volume': return { kind: 'volume', boxes: boxes(value.boxes) }
    case 'point': return { kind: 'point', point: point(value.point) }
    default: throw new Error('Supply a surface, curve, volume, or point location for the region')
  }
}

function validateHierarchy(regions) {
  const byId = new Map(regions.map(region => [region.id, region]))
  for (const region of regions) {
    if (region.parentId === undefined) continue
    const parent = byId.get(region.parentId)
    if (!parent) throw new Error(`Region "${region.id}": parentId must refer to a saved region`)
    if (region.location.kind !== 'surface' || parent.location.kind !== 'surface') {
      throw new Error(`Region "${region.id}": a nested region and its parent must both select surfaces`)
    }
  }
  const checked = new Set()
  for (const region of regions) {
    const chain = new Set()
    for (let ancestor = region; ancestor && !checked.has(ancestor.id); ancestor = byId.get(ancestor.parentId)) {
      if (chain.has(ancestor.id)) throw new Error(`Region "${region.id}": parentId links form a cycle`)
      chain.add(ancestor.id)
    }
    for (const id of chain) checked.add(id)
  }
}

/**
 * Validate the metadata saved beside a USD model. A region without parentId is a top-level feature.
 * @param {object} value Parsed region metadata.
 * @param {string} hash Hash of the displayed geometry.
 * @returns {FeatureMap|null} Valid metadata, or null for another revision.
 * @throws {Error} For invalid metadata, including missing or cyclic surface parents.
 */
export function readModelRegions(value, hash) {
  if (!value || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceHash)) throw new Error('Region map needs a USD SHA-256')
  if (value.sourceHash !== hash) return null
  if (!boundedArray(value.regions, 1, maxRegions)) throw new Error(`Supply between 1 and ${maxRegions} named features`)
  const ids = new Set(['remainder'])
  const regions = value.regions.map(region => {
    if (!region || typeof region.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(region.id) || ids.has(region.id)) throw new Error('Use a distinct lowercase ID for each region')
    ids.add(region.id)
    const feature = { id: region.id, name: name(region.name) }
    if (region.parentId !== undefined) {
      if (typeof region.parentId !== 'string') throw new Error(`Region "${region.id}": set parentId to a saved region's ID`)
      feature.parentId = region.parentId
    }
    if (region.description !== undefined) feature.description = text(region.description, 240, 'Supply a region description of up to 240 characters')
    if (region.aliases !== undefined) {
      if (!boundedArray(region.aliases, 1, 8)) throw new Error('Supply up to 8 aliases for a region')
      feature.aliases = region.aliases.map(name)
    }
    if (region.boxes !== undefined) {
      if (region.location !== undefined) throw new Error('Supply one location for each region')
      const legacyBoxes = boxes(region.boxes)
      return { ...feature, location: { kind: 'volume', boxes: legacyBoxes }, boxes: legacyBoxes }
    }
    try {
      return { ...feature, location: location(region.location) }
    } catch (error) {
      throw new Error(`Region "${feature.id}": ${error.message}`, { cause: error })
    }
  })
  validateHierarchy(regions)
  const remainder = value.remainder === undefined ? null : { id: 'remainder', name: name(value.remainder) }
  return { regions, remainder }
}

/**
 * Identify maps with old box labels or only spatial guides for a model's physical features.
 * @param {FeatureMap} map Validated feature map for the saved model.
 * @returns {boolean} Whether model naming still needs mesh-backed selections.
 */
export function needsSurfaceRegions(map) {
  return map.regions.some(region => region.boxes)
    || (map.regions.some(region => region.location.kind === 'volume') && !map.regions.some(region => region.location.kind === 'surface'))
}

/**
 * Resolve an exact feature ID or an unambiguous human-facing name or alias.
 * @param {FeatureMap|null|undefined} map Validated region map for the displayed revision.
 * @param {string} reference Feature ID, name, or alias.
 * @returns {{status: 'found', region: ModelFeature} | {status: 'ambiguous', matches: {id: string, name: string}[]} | {status: 'unknown'}} Matched region, competing identities, or unknown status.
 */
export function findModelRegion(map, reference) {
  if (!map) return { status: 'unknown' }
  const exact = map.regions.find(region => region.id === reference.trim())
  if (exact) return { status: 'found', region: exact }
  const key = featureKey(reference)
  const regions = map.regions.filter(region => [region.name, ...(region.aliases ?? [])].some(name => featureKey(name) === key))
  if (regions.length === 1) return { status: 'found', region: regions[0] }
  if (regions.length === 0) return { status: 'unknown' }
  return { status: 'ambiguous', matches: regions.map(({ id, name }) => ({ id, name })) }
}

/**
 * Identify unambiguous feature phrases in user text, preferring the longest phrase at each position.
 * @param {FeatureMap|null|undefined} map Validated region map for the displayed revision.
 * @param {string} value Message text from one user request.
 * @returns {ModelFeature[]} Distinct feature entries in mention order; these do not establish user intent.
 */
export function mentionedModelRegions(map, value) {
  if (!map) return []
  const text = featureKey(value)
  const words = new Set([text.length])
  for (const segment of segmenter.segment(text)) words.add(segment.index)
  const terms = new Map()
  for (const region of map.regions) {
    for (const name of [region.name, ...(region.aliases ?? [])]) {
      const term = featureKey(name)
      const matches = terms.get(term) ?? new Set()
      matches.add(region)
      terms.set(term, matches)
    }
  }
  const matches = []
  for (const [term, regions] of terms) {
    for (let start = text.indexOf(term); start !== -1; start = text.indexOf(term, start + 1)) {
      const end = start + term.length
      if (words.has(start) && words.has(end)) matches.push({ start, end, regions })
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const accepted = new Set()
  let end = 0
  for (const match of matches) {
    if (match.start < end) continue
    end = match.end
    if (match.regions.size === 1) for (const region of match.regions) accepted.add(region)
  }
  return [...accepted]
}

/**
 * Find a volume at the given model-local point. Earlier, more specific volumes take priority.
 * @param {FeatureMap} map A validated region map.
 * @param {number[]} point XYZ in saved model millimetres.
 * @returns {ModelFeature|{id: string, name: string}|null} Named volume, legacy remainder, or null.
 */
export function modelRegionAt(map, point) {
  const [x, y, z] = point
  return map.regions.find(region => region.location.kind === 'volume' && region.location.boxes.some(([xmin, ymin, zmin, xmax, ymax, zmax]) =>
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
