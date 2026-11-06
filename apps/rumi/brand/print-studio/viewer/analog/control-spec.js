/** Declarative controls bind labeled inputs to numeric model values. */
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Validate numeric model parameters from files or tool input. @param {object} values Parameter dictionary. @returns {object} Independent numeric values. */
export function parameterValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) throw new Error('Provide at most 32 numeric parameters')
  const result = {}
  for (const [key, value] of Object.entries(values)) {
    if (!KEY.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || !Number.isFinite(value) || Math.abs(value) > 1000000) throw new Error(`Invalid parameter: ${key}`)
    result[key] = value
  }
  return result
}

/** Validate declarations and their initial or released values. @param {object[]} controls Labeled inputs with one or two axes. @param {object} values Bound values. @returns {object[]} Canonical declarations. */
export function normalizeControls(controls, values) {
  const checked = parameterValues(values), used = new Set()
  if (!Array.isArray(controls) || !controls.length || controls.length > 12) throw new Error('Provide 1–12 controls')
  return controls.map(control => {
    if (!['slider', 'pad', 'curve'].includes(control.kind)) throw new Error('Use slider, pad, or curve controls')
    if (typeof control.label !== 'string' || !control.label.trim() || control.label.length > 80) throw new Error('Give each control a short label')
    if (!Array.isArray(control.axes) || control.axes.length !== (control.kind === 'pad' ? 2 : 1)) throw new Error('Pads need two axes; sliders and curves need one')
    const axes = control.axes.map(axis => {
      const { key, min, max, step, reset } = axis
      if (!KEY.test(key) || used.has(key) || !Object.hasOwn(checked, key)) throw new Error(`Missing or duplicate control binding: ${key}`)
      if (![min, max, step, reset].every(Number.isFinite) || min >= max || step <= 0 || step > max - min || reset < min || reset > max || Math.max(Math.abs(min), Math.abs(max)) > 1000000) throw new Error(`Invalid control range: ${key}`)
      if (checked[key] < min || checked[key] > max) throw new Error(`Control value outside range: ${key}`)
      used.add(key)
      return { key, min, max, step, reset }
    })
    return { kind: control.kind, label: control.label.trim(), axes }
  })
}

/** Read released values using the open control definitions. @param {object} spec Open control session. @param {object} values Released values. @returns {object} Validated values. */
export function controlValues(spec, values) {
  const next = parameterValues(values)
  if (Object.keys(next).sort().join() !== Object.keys(spec.values).sort().join()) throw new Error('Control bindings changed')
  normalizeControls(spec.controls, next)
  return next
}

/** Declarations for reading older fixed-operation recipes. @param {string} operation Legacy operation. @returns {object[]} Legacy neutral controls. */
export function legacyControls(operation) {
  const axis = key => ({ key, min: 0, max: 1, step: .001, reset: .5 })
  const slider = (key, label) => ({ kind: 'slider', label, axes: [axis(key)] })
  if (operation === 'cut') return [slider('amount', 'cutHeight'), slider('angle', 'cutTilt'), slider('spread', 'cutLean')]
  return [slider('amount', 'shapeAmount'), slider('spread', 'shapeSpread'),
    ...(operation === 'bulge' ? [slider('angle', 'shapeAngle')] : []),
    { kind: 'pad', label: 'shapePeak', axes: [axis('peakX'), axis('peakY')] },
    { kind: 'curve', label: 'shapeCurve', axes: [axis('falloff')] }]
}
