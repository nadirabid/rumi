/** Fixed, continuous shape operations in model-local millimetres. */
import { normalizeFields } from './fields.js'
import { normalizeControls, parameterValues, legacyControls } from './control-spec.js'
export const OPERATIONS = ['bulge', 'bend', 'twist', 'taper', 'cut']
export const INITIAL_VALUES = Object.freeze({ amount: 0.65, spread: 0.5, peakX: 0.5, peakY: 0.5, falloff: 0.5, angle: 0.5 })

/** Validate control values at model, file, or browser boundaries. @param {object} value Complete normalized values. @returns {object} Bounded values. */
export function normalizeValues(value) {
  const result = {}
  for (const key of Object.keys(INITIAL_VALUES)) {
    if (!Number.isFinite(value?.[key]) || value[key] < 0 || value[key] > 1) throw new Error(`Invalid shape control: ${key}`)
    result[key] = value[key]
  }
  return result
}

/** Validate a deformation selected by the agent. @param {object} value Operation and local frame. @returns {object} Canonical recipe. */
export function normalizeShape(value) {
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160) throw new Error('Give the region a short label')
  if (value.operation === 'fields') {
    const values = parameterValues(value.values), controls = normalizeControls(value.controls, values)
    if (!Array.isArray(value.parts) || !value.parts.length || value.parts.length > 64 || value.parts.some(p => typeof p !== 'string' || !p || p.length > 200) || new Set(value.parts).size !== value.parts.length) throw new Error('Fields require exact, distinct mesh names')
    const fields = normalizeFields(value.fields, values)
    if (fields.length !== Object.keys(values).length || controls.flatMap(c => c.axes).length !== fields.length || controls.some(c => c.axes.some(a => a.min < -1 || a.max > 1 || a.reset !== 0))) throw new Error('Expose every field with ranges within -1..1 and reset zero')
    return { version: 1, operation: 'fields', label: value.label.trim(), parts: [...value.parts], fields, values, controls }
  }
  if (value.operation === 'parameters') {
    const values = parameterValues(value.values), controls = normalizeControls(value.controls, values)
    const finish = value.finish ?? 'parameters'
    if (!['parameters', 'cad', 'blender'].includes(finish)) throw new Error('Choose parameters or cad for finishing')
    const external = finish === 'cad' || finish === 'blender'
    if (external && (typeof value.original !== 'string' || !value.original.trim() || typeof value.edit !== 'string' || !value.edit.trim() || value.edit.length > 4000)) throw new Error('CAD previews require the preserved original path and an edit recipe')
    return { version: 2, operation: 'parameters', label: value.label.trim(), controls, values, finish, ...(external ? { original: value.original, originalHash: value.originalHash, edit: value.edit.trim() } : {}) }
  }
  if (value.operation === 'surface') return normalizeSurface(value)
  const vector = (key, positive = false) => {
    const v = value[key]
    if (!Array.isArray(v) || v.length !== 3 || v.some(n => !Number.isFinite(n) || Math.abs(n) > 100000 || (positive && n < 0.01))) throw new Error(`Invalid ${key}`)
    return [...v]
  }
  if (!OPERATIONS.includes(value.operation)) throw new Error('Unsupported shape operation')
  const center = vector('center'), radii = vector('radii', true), direction = vector('direction')
  const length = Math.hypot(...direction)
  if (length < 0.001) throw new Error('Direction must be nonzero')
  if (!Number.isFinite(value.limit) || value.limit <= 0 || value.limit > Math.min(...radii)) throw new Error('Limit must be positive and no larger than the smallest region radius')
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160) throw new Error('Give the region a short label')
  if (!Array.isArray(value.parts) || value.parts.length > 64 || value.parts.some(p => typeof p !== 'string' || !p || p.length > 200)) throw new Error('parts must contain mesh names, or be empty for all meshes')
  const values = normalizeValues(value.values), controls = normalizeControls(value.controls ?? legacyControls(value.operation), values)
  if (controls.some(control => control.axes.some(axis => axis.min !== 0 || axis.max !== 1))) throw new Error('Mesh-operation bindings use normalized ranges 0..1')
  return { version: 1, operation: value.operation, label: value.label.trim(), center, radii, direction: direction.map(n => n / length), limit: value.limit, parts: [...value.parts], values, controls }
}

/** Stable right-handed frame: U across, V up, N outward. @param {number[]} n Unit direction. @returns {number[][]} Frame axes. */
export function shapeFrame(n) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]
  const u = [up[1]*n[2]-up[2]*n[1], up[2]*n[0]-up[0]*n[2], up[0]*n[1]-up[1]*n[0]]
  const length = Math.hypot(...u); for (let i=0;i<3;i++) u[i] /= length
  const v = [n[1]*u[2]-n[2]*u[1], n[2]*u[0]-n[0]*u[2], n[0]*u[1]-n[1]*u[0]]
  return [u,v,n]
}

/** CPU reference matching the shader and CAD helper. @param {number[]} point Model-local point. @param {object} spec Validated recipe. @returns {number[]} Deformed point. */
export function deformPoint(point, spec) {
  if (spec.operation === 'cut') throw new Error('A cut changes topology; use cutPlane instead of deformPoint')
  const [u,v,n] = shapeFrame(spec.direction), a = spec.values
  const center = spec.center.map((c,i)=>c + u[i]*(a.peakX-.5)*spec.radii[0] + v[i]*(a.peakY-.5)*spec.radii[1])
  const delta = point.map((p,i)=>p-center[i]), dot = axis=>delta.reduce((sum,x,i)=>sum+x*axis[i],0)
  const q = [dot(u),dot(v),dot(n)], spread=.5+a.spread
  const r2=q.reduce((sum,x,i)=>sum+(x/(spec.radii[i]*spread))**2,0)
  const w=Math.pow(Math.max(0,1-r2),1.5+4*a.falloff), strength=a.amount*2-1
  const out=[...q], tilt=(a.angle-.5)*Math.PI*2/3
  if(spec.operation==='bulge'){out[1]+=Math.sin(tilt)*strength*spec.limit*w;out[2]+=Math.cos(tilt)*strength*spec.limit*w}
  else if(spec.operation==='taper'){const scale=1+strength*.6*w;out[0]*=scale;out[1]*=scale}
  else {const angle=strength*Math.PI/2*w*(spec.operation==='bend'?q[1]/spec.radii[1]:q[2]/spec.radii[2]);const c=Math.cos(angle),s=Math.sin(angle);if(spec.operation==='twist'){out[0]=c*q[0]-s*q[1];out[1]=s*q[0]+c*q[1]}else{out[1]=c*q[1]-s*q[2];out[2]=s*q[1]+c*q[2]}}
  return point.map((p,i)=>p+u[i]*(out[0]-q[0])+v[i]*(out[1]-q[1])+n[i]*(out[2]-q[2]))
}

/** Resolve the retained half-space of a continuous cut. @param {object} spec Validated recipe. @returns {object} Unit normal, plane point and signed constant in model millimetres; nonnegative distances are retained. */
export function cutPlane(spec) {
  const [u, v, n] = shapeFrame(spec.direction)
  const pitch = Math.tan((spec.values.angle - .5) * Math.PI * 2 / 3)
  const lean = Math.tan((spec.values.spread - .5) * Math.PI * 2 / 3)
  const normal = n.map((value, i) => value - v[i] * pitch - u[i] * lean)
  const length = Math.hypot(...normal)
  for (let i = 0; i < 3; i++) normal[i] /= length
  const point = spec.center.map((value, i) => value + n[i] * (spec.values.amount * 2 - 1) * spec.limit)
  return { normal, point, constant: -normal.reduce((sum, value, i) => sum + value * point[i], 0) }
}

/** Axes each surface form requires, so controls always bind a real parameter. */
const SURFACE_AXES = { profile: ['amount'], ring: ['amount'], facet: ['amount'], channel: ['depth'] }
const SURFACE_KINDS = Object.keys(SURFACE_AXES)

/**
 * Validate a deformation stated in the part's own cylindrical coordinates.
 * @param {object} value Untrusted recipe from the tool call.
 * @returns {object} Canonical surface recipe.
 */
function normalizeSurface(value) {
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160) throw new Error('Give the region a short label')
  if (!Array.isArray(value.parts) || !value.parts.length || value.parts.length > 16
    || value.parts.some(part => typeof part !== 'string' || !part || part.length > 200) || new Set(value.parts).size !== value.parts.length) {
    throw new Error('Surface deformation needs exact, distinct mesh names')
  }
  const uAt = value.uAt === undefined ? -90 : value.uAt
  if (!Number.isFinite(uAt) || Math.abs(uAt) > 360) throw new Error('The front meridian must be an angle in degrees')
  const form = value.form
  if (!form || typeof form !== 'object' || !SURFACE_KINDS.includes(form.kind)) throw new Error('Choose a surface form: profile, ring, channel or facet')
  const number = (source, name, min, max) => {
    const raw = source[name]
    if (!Number.isFinite(raw) || raw < min || raw > max) throw new Error(`Surface ${name} must be between ${min} and ${max}`)
    return raw
  }
  const span = source => {
    const from = number(source, 'from', 0, 1), to = number(source, 'to', 0, 1)
    if (!(to > from)) throw new Error('Surface bands need from below to')
    return { from, to }
  }
  const lateral = form.lateral === undefined ? 1 : number(form, 'lateral', 1, 8)
  const edge = form.edge === undefined ? .08 : number(form, 'edge', .01, .5)
  let normalized
  if (form.kind === 'profile') {
    const at = form.at
    if (!Array.isArray(at) || at.length < 2 || at.length > 8) throw new Error('A surface profile needs form.at with 2–8 rising knot positions')
    let previous = -1
    for (const position of at) {
      if (!Number.isFinite(position) || position < 0 || position > 1 || position <= previous) throw new Error('Surface form.at knot positions must rise within 0..1')
      previous = position
    }
    const pinned = form.pinned ?? []
    if (!Array.isArray(pinned) || pinned.some(i => !Number.isInteger(i) || i < 0 || i >= at.length) || new Set(pinned).size !== pinned.length || pinned.length === at.length) throw new Error('Pinned profile stations must be distinct indices and leave an adjustable station')
    const links = form.links ?? {}
    if (!links || typeof links !== 'object' || Array.isArray(links) || Object.entries(links).some(([i, target]) => !/^[0-7]$/.test(i) || Number(i) >= at.length || !Number.isInteger(target) || target < 0 || target >= Number(i) || pinned.includes(Number(i)) || pinned.includes(target) || Object.hasOwn(links, target))) throw new Error('Profile links must reference an earlier unpinned, unlinked station')
    const directions = form.directions ?? at.map(t => [-Math.sin((t - .5) * 2 * Math.PI), Math.cos((t - .5) * 2 * Math.PI)])
    if (!Array.isArray(directions) || directions.length !== at.length || directions.some(d => !Array.isArray(d) || d.length !== 2 || d.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...d) - 1) > 1e-6)) throw new Error('Profile directions need one unit [front, up] vector per station')
    normalized = { kind: 'profile', lateral, at: [...at], pinned: [...pinned], links: { ...links }, directions: directions.map(d => [...d]) }
  } else if (form.kind === 'ring') {
    normalized = { kind: 'ring', lateral, ...span(form), millimetres: number(form, 'millimetres', -500, 500), edge }
  } else if (form.kind === 'channel') {
    if (!Array.isArray(form.at) || !form.at.length || form.at.length > 4 || form.at.some(at => !Number.isFinite(at) || Math.abs(at) > 180)) {
      throw new Error('A channel needs 1–4 meridian angles within ±180')
    }
    normalized = { kind: 'channel', lateral, ...span(form), at: [...form.at], widthMillimetres: number(form, 'widthMillimetres', .5, 400), edge }
  } else {
    if (!Array.isArray(form.planes) || !form.planes.length || form.planes.length > 12) throw new Error('Facet needs 1–12 target planes')
    const planes = form.planes.map(plane => {
      if (!Array.isArray(plane?.normal) || plane.normal.length !== 3 || plane.normal.some(n => !Number.isFinite(n))) throw new Error('Facet plane needs a finite normal')
      const length = Math.hypot(...plane.normal)
      if (Math.abs(length - 1) > 1e-6) throw new Error('Facet plane normal must have unit length')
      return { normal: [...plane.normal], offset: number(plane, 'offset', -100000, 100000) }
    })
    for (let i = 0; i < planes.length; i++) for (const other of planes.slice(i + 1)) {
      const plane = planes[i], dot = plane.normal.reduce((sum, n, j) => sum + n * other.normal[j], 0)
      if (Math.abs(dot) > 1e-6 && Math.abs(dot + 1) > 1e-6) throw new Error('Facet planes must be opposing or perpendicular; use separate edits for other planes')
      if (dot < -.999999 && plane.offset + other.offset <= 2 * (form.wallThickness ?? 0)) throw new Error('Opposing facet planes leave no room for the shell')
    }
    normalized = { kind: 'facet', ...span(form), planes, edge, ...(form.wallThickness === undefined ? {} : { wallThickness: number(form, 'wallThickness', .1, 100) }) }
  }
  const required = normalized.kind === 'profile' ? normalized.at.flatMap((_position, index) => normalized.pinned.includes(index) || Object.hasOwn(normalized.links, index) ? [] : [`p${index}`]) : SURFACE_AXES[normalized.kind]
  const values = parameterValues(value.values ?? {})
  if (Object.keys(values).sort().join() !== [...required].sort().join()) throw new Error(`Surface ${normalized.kind} binds exactly: ${required.join(', ')}`)
  const controls = normalizeControls(value.controls, values)
  const axes = controls.flatMap(control => control.axes)
  if (axes.length !== required.length) throw new Error('Every surface parameter needs a control')
  for (const axis of axes) {
    if (!required.includes(axis.key)) throw new Error(`Unknown surface axis: ${axis.key}`)
    if (Math.max(Math.abs(axis.min), Math.abs(axis.max)) > 1000 || axis.reset !== 0) throw new Error('Surface ranges must stay within ±1000 and reset to zero')
  }
  if (normalized.kind === 'facet' && (values.amount < 0 || values.amount > 1 || controls.some(control => control.axes.some(axis => axis.min < 0 || axis.max > 1)))) throw new Error('Facet amount and its control range must stay within 0..1')
  return { version: 1, operation: 'surface', label: value.label.trim(), parts: [...value.parts], uAt, form: normalized, values, controls }
}
