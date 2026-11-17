/** Source-bound profile, ring, channel, and planar-patch deformations in model millimetres. */
import * as THREE from 'three'
import { controlValues } from './control-spec.js'

/** Wrap an angle to (-180, 180]. @param {number} value Degrees. @returns {number} Wrapped degrees. */
export function wrapDeg(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Fade in and out over a normalised band. @param {number} v Position in 0..1. @param {number} from Band start. @param {number} to Band end. @param {number} edge Fade width in v. @returns {number} Weight in 0..1. */
export function bandWeight(v, from, to, edge = .08) {
  if (!(to > from)) return 0
  const fade = Math.min(edge, (to - from) / 2)
  return smoothstep(from, from + fade, v) * (1 - smoothstep(to - fade, to, v))
}

/** Derive a duplication-independent frame from selected bounds. @param {{point: number[]}[]} samples Model-local millimetre vertices. @param {number} uAt Front angle in degrees. @returns {object} Selection frame. */
export function surfaceContext(samples, uAt = -90) {
  if (!samples.length) throw new Error('Surface deformation needs visible mesh vertices')
  const bounds = new THREE.Box3()
  for (const { point } of samples) bounds.expandByPoint(new THREE.Vector3(...point))
  const center = [(bounds.min.x + bounds.max.x) / 2, (bounds.min.y + bounds.max.y) / 2], angle = uAt * Math.PI / 180
  let sideExtent = 0
  for (const { point } of samples) sideExtent = Math.max(sideExtent, Math.abs(-(point[0] - center[0]) * Math.sin(angle) + (point[1] - center[1]) * Math.cos(angle)))
  return { center, zMin: bounds.min.z, zMax: bounds.max.z, uAt, sideExtent }
}

/** Interpolate profile travel with continuous first derivatives and no overshoot. @param {number[][]} pairs Sorted stations and millimetre values. @param {number} x Section position. @returns {number} Travel. */
export function profileTravel(pairs, x) {
  if (x <= pairs[0][0]) return pairs[0][1]
  for (let i = 1; i < pairs.length; i++) {
    if (x <= pairs[i][0]) {
      const [a, va] = pairs[i - 1], [b, vb] = pairs[i]
      return va + (vb - va) * smoothstep(a, b, x)
    }
  }
  return pairs[pairs.length - 1][1]
}

/**
 * Displacement of one point, in millimetres.
 * @param {number[]} point Model-local millimetre position.
 * @param {object} context Frame from {@link surfaceContext}.
 * @param {object} form Validated form declaration.
 * @param {object} values Bound numeric values.
 * @param {number[]|null} normal Original outward model-space normal; required for shell facets.
 * @returns {number[]} Displacement vector.
 */
export function surfaceDelta(point, context, form, values, normal = null) {
  const dx = point[0] - context.center[0], dy = point[1] - context.center[1]
  const v = Math.min(1, Math.max(0, (point[2] - context.zMin) / Math.max(context.zMax - context.zMin, 1e-6)))
  if (form.kind === 'facet') {
    const moved = [...point]
    for (const plane of form.planes) {
      const facing = normal ? normal.reduce((sum, value, i) => sum + value * plane.normal[i], 0) : 0
      if (form.wallThickness !== undefined && !normal) throw new Error('Shell facets require original surface normals')
      const offset = plane.offset - (form.wallThickness !== undefined && facing < 0 ? form.wallThickness : 0)
      const distance = moved.reduce((sum, value, i) => sum + value * plane.normal[i], -offset)
      if (form.wallThickness !== undefined && distance > 0 && bandWeight(v, form.from, form.to, form.edge) > 0 && Math.abs(facing) < .1) {
        throw new Error(`Facet crosses an ambiguous shell edge at ${point.map(n => n.toFixed(2)).join(', ')} mm; narrow the band or reconstruct this region`)
      }
      if (distance > 0) for (let i = 0; i < 3; i++) moved[i] -= distance * plane.normal[i]
    }
    const weight = values.amount * bandWeight(v, form.from, form.to, form.edge)
    return moved.map((value, i) => (value - point[i]) * weight)
  }
  const angle = context.uAt * Math.PI / 180
  const front = dx * Math.cos(angle) + dy * Math.sin(angle)
  const side = -dx * Math.sin(angle) + dy * Math.cos(angle)
  if (form.kind === 'profile') {
    const height = point[2] - (context.zMin + context.zMax) / 2
    const radius = Math.hypot(front, height)
    if (radius < 1e-6) return [0, 0, 0]
    const section = .5 + Math.atan2(-front, height) / (2 * Math.PI)
    const pairs = component => form.at.map((at, i) => {
      const theta = (at - .5) * 2 * Math.PI
      const direction = form.directions?.[i] ?? [-Math.sin(theta), Math.cos(theta)]
      return [at, (values[`p${form.links?.[i] ?? i}`] ?? 0) * direction[component]]
    })
    const width = Math.max(context.sideExtent / form.lateral, 1e-6)
    const weight = (1 - smoothstep(width / 2, width, Math.abs(side))) * smoothstep(0, .02, section) * (1 - smoothstep(.98, 1, section))
    const along = profileTravel(pairs(0), section) * weight, up = profileTravel(pairs(1), section) * weight
    return [Math.cos(angle) * along, Math.sin(angle) * along, up]
  }
  const radius = Math.hypot(dx, dy)
  if (radius < 1e-6) return [0, 0, 0]
  const uRel = wrapDeg(Math.atan2(dy, dx) * 180 / Math.PI - context.uAt)
  let amount = 0
  if (form.kind === 'ring') amount = values.amount * form.millimetres * bandWeight(v, form.from, form.to, form.edge)
  else if (form.kind === 'channel') {
    let across = 0
    for (const at of form.at) {
      const half = form.widthMillimetres / (2 * radius)
      const angle = Math.abs(wrapDeg(uRel - at)) * Math.PI / 180
      across = Math.max(across, 1 - smoothstep(0, half, angle))
    }
    amount = -values.depth * across * bandWeight(v, form.from, form.to, form.edge)
  }
  return [dx / radius * amount, dy / radius * amount, 0]
}

/**
 * Attach a reversible surface preview that recomputes displacement per value.
 * @param {THREE.Object3D} root Saved model root.
 * @param {object} spec Validated surface recipe.
 * @returns {object} Update and disposal methods.
 */
export function createSurfacePreview(root, spec) {
  const owned = [], samples = []
  let context
  root.updateWorldMatrix(true, true)
  const parentInverse = root.parent ? root.parent.matrixWorld.clone().invert() : new THREE.Matrix4()
  try {
    root.traverseVisible(node => {
      if (!node.isMesh || !spec.parts.includes(node.name)) return
      const source = node.geometry, geometry = source.clone(), matrix = parentInverse.clone().multiply(node.matrixWorld), inverse = matrix.clone().invert()
      const item = { node, source, geometry, matrix, inverse }
      owned.push(item)
      const position = geometry.getAttribute('position'), normals = geometry.getAttribute('normal')
      if (spec.form.wallThickness !== undefined && !normals) throw new Error('Shell facets require original surface normals')
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
      item.originalNormals = normals ? Array.from({ length: normals.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize().toArray()) : null
      item.baseline = position.array.slice()
      item.points = Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix).toArray())
      for (const point of item.points) samples.push({ point })
      const groups = new Map()
      item.groups = Array.from({ length: position.count }, (_, i) => {
        const key = [...item.baseline.slice(i * 3, i * 3 + 3), ...(normals ? Array.from(normals.array.slice(i * 3, i * 3 + 3)) : [])].join(',')
        if (!groups.has(key)) groups.set(key, groups.size)
        return groups.get(key)
      })
      item.normalSums = new Float64Array(groups.size * 3)
    })
    if (!owned.length || spec.parts.some(name => !owned.some(item => item.node.name === name))) throw new Error('Surface parts must match visible meshes exactly')
    context = surfaceContext(samples, spec.uAt)
    const zero = Object.fromEntries(Object.keys(spec.values).map(key => [key, 0]))
    for (const item of owned) {
      item.deltas = Object.fromEntries(Object.keys(zero).map(key => {
        const deltas = new Float32Array(item.baseline.length), moved = new THREE.Vector3()
        item.points.forEach((point, i) => {
          const delta = surfaceDelta(point, context, spec.form, { ...zero, [key]: 1 }, item.originalNormals?.[i])
          moved.set(...point.map((n, j) => n + delta[j])).applyMatrix4(item.inverse)
          for (let j = 0; j < 3; j++) deltas[i * 3 + j] = moved.getComponent(j) - item.baseline[i * 3 + j]
        })
        return [key, deltas]
      }))
    }
  } catch (error) { for (const item of owned) item.geometry.dispose(); throw error }
  for (const item of owned) item.node.geometry = item.geometry
  function update(values) {
    const checked = controlValues(spec, values)
    for (const item of owned) {
      const position = item.geometry.getAttribute('position')
      position.array.set(item.baseline)
      for (const [key, delta] of Object.entries(item.deltas)) {
        for (let i = 0; i < delta.length; i++) position.array[i] += delta[i] * checked[key]
      }
      position.needsUpdate = true
      if (Object.values(checked).every(value => value === 0) && item.source.getAttribute('normal')) {
        item.geometry.setAttribute('normal', item.source.getAttribute('normal').clone())
      } else updateNormals(item)
      item.geometry.computeBoundingBox(); item.geometry.computeBoundingSphere()
    }
    return true
  }
  try { update(spec.values) } catch (error) {
    for (const { node, source, geometry } of owned) { node.geometry = source; geometry.dispose() }
    throw error
  }
  return { context, update, dispose() { for (const { node, source, geometry } of owned) { node.geometry = source; geometry.dispose() } } }
}

// USD expands triangle corners. Preserve authored smoothing groups instead of making every triangle flat.
function updateNormals(item) {
  const { geometry, groups, normalSums } = item
  const position = geometry.getAttribute('position'), index = geometry.index
  if (!geometry.getAttribute('normal')) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(position.count * 3), 3))
  const normal = geometry.getAttribute('normal'), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  normalSums.fill(0)
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const ids = [0, 1, 2].map(j => index ? index.getX(i + j) : i + j)
    a.fromBufferAttribute(position, ids[0]); b.fromBufferAttribute(position, ids[1]); c.fromBufferAttribute(position, ids[2])
    b.sub(a); c.sub(a); b.cross(c)
    for (const id of ids) for (let j = 0; j < 3; j++) normalSums[groups[id] * 3 + j] += b.getComponent(j)
  }
  for (let i = 0; i < position.count; i++) {
    a.fromArray(normalSums, groups[i] * 3).normalize()
    normal.setXYZ(i, a.x, a.y, a.z)
  }
  normal.needsUpdate = true
}
