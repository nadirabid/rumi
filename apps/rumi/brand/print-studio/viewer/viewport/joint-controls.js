/** Resolve USD widget declarations against physical movement ranges. */
import { normalizeControls } from '../analog/control-spec.js'

/** Bind declared widgets, retaining automatic sliders for undeclared movements.
 * @param {object} presentation Parsed USD controls and absolute joint paths.
 * @param {Map<string, object>} bindings Joint identifiers mapped to movement keys.
 * @param {object[]} defaults Automatic sliders with physical limits and saved origins.
 * @param {object} values Saved movement values.
 * @returns {object[]} Validated controls. Throws for invalid or duplicate bindings.
 */
export function jointControls(presentation, bindings, defaults, values) {
  const { controls, joints } = presentation
  if (!Array.isArray(controls) || !controls.length || controls.length > 12) throw new Error('rumi:motionControls requires 1–12 controls')
  const axes = new Map(defaults.flatMap(control => control.axes.map(axis => [axis.key, axis])))
  const used = new Set()
  const declared = controls.map(control => {
    if (!control || typeof control !== 'object' || Object.keys(control).some(key => !['kind', 'label', 'axes'].includes(key))) {
      throw new Error('Motion controls accept kind, label and axes')
    }
    if (!Array.isArray(control.axes)) throw new Error('Motion controls require joint axes')
    return { kind: control.kind, label: control.label, axes: control.axes.map(axis => {
      if (!axis || typeof axis !== 'object' || Object.keys(axis).some(key => !['joint', 'step'].includes(key))) {
        throw new Error('Motion axes accept joint and optional step; limits and reset come from the joint')
      }
      const binding = bindings.get(joints.get(axis.joint))
      if (!binding) throw new Error(`Motion control must reference a movable joint: ${axis.joint}`)
      if (used.has(binding.key)) throw new Error(`Movement is bound more than once: ${axis.joint}`)
      used.add(binding.key)
      return { ...axes.get(binding.key), ...(axis.step === undefined ? {} : { step: axis.step }) }
    }) }
  })
  return normalizeControls([...declared, ...defaults.filter(control => !used.has(control.axes[0].key))], values)
}
