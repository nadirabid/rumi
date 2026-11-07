/** Model-owned movement declarations outlive temporary editing controls. */
import { normalizeControls, parameterValues } from './analog/control-spec.js'

/**
 * Read movement controls from a model module, keeping compatible preview values.
 * @param {object[]} definitions Model's exported motionControls, if any.
 * @param {object} parameters Effective saved model parameters.
 * @param {object} retained Previous preview pose for this model.
 * @returns {object|null} Validated declarations and pose, or null without movement controls.
 */
export function readMotion(definitions, parameters, retained = {}) {
  if (definitions === undefined || (Array.isArray(definitions) && !definitions.length)) return null
  const controls = normalizeControls(definitions, parameterValues(parameters))
  const values = {}
  for (const control of controls) for (const axis of control.axes) {
    const previous = retained[axis.key]
    values[axis.key] = Number.isFinite(previous) && previous >= axis.min && previous <= axis.max ? previous : parameters[axis.key]
  }
  return { controls, values }
}
