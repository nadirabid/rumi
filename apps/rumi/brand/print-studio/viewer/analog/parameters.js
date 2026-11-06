/** Parameter previews rebuild project geometry locally and preserve the saved model until committed. */
import { buildModel, disposeModel } from '../viewport/model.js'
import { controlValues } from './control-spec.js'

/** Create a preview bound to a model's declared parameters. @param {object} parent Placement group. @param {object} model Saved model and builder. @param {object} spec Validated controls. @returns {object} Update and disposal methods. */
export function createParameterPreview(parent, model, spec) {
  if (!model.build || !model.parameters || Object.keys(spec.values).some(key => !Object.hasOwn(model.parameters, key))) throw new Error('Controls must bind declared model parameters')
  let preview = null, previous = null
  const visible = model.root.visible
  return {
    update(values) {
      const checked = controlValues(spec, values), key = JSON.stringify(checked)
      if (key === previous) return
      const next = buildModel(model.build, { ...model.parameters, ...checked })
      if (preview) { parent.remove(preview.root); disposeModel(preview.root) }
      preview = next; previous = key
      model.root.visible = false; parent.add(next.root)
    },
    dispose() {
      if (preview) { parent.remove(preview.root); disposeModel(preview.root); preview = null }
      model.root.visible = visible
    },
  }
}
