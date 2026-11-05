/** Fixed, continuous shape operations in model-local millimetres. */
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
  return { version: 1, operation: value.operation, label: value.label.trim(), center, radii, direction: direction.map(n => n / length), limit: value.limit, parts: [...value.parts], values: normalizeValues(value.values) }
}

/** Stable right-handed frame: U across, V up, N outward. @param {number[]} n Unit direction. @returns {number[][]} Frame axes. */
export function shapeFrame(n) {
  const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]
  const u = [up[1]*n[2]-up[2]*n[1], up[2]*n[0]-up[0]*n[2], up[0]*n[1]-up[1]*n[0]]
  const length = Math.hypot(...u); for (let i=0;i<3;i++) u[i] /= length
  const v = [n[1]*u[2]-n[2]*u[1], n[2]*u[0]-n[0]*u[2], n[0]*u[1]-n[1]*u[0]]
  return [u,v,n]
}

/** CPU reference matching the shader and Blender helper. @param {number[]} point Model-local point. @param {object} spec Validated recipe. @returns {number[]} Deformed point. */
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
