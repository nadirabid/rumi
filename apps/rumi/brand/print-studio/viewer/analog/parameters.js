/** Parameter previews rebuild project geometry locally and preserve the saved model until committed. */
import { disposeModel } from '../viewport/model.js'
import { parseGlbModel } from '../viewport/glb.js'
import { controlValues } from './control-spec.js'

/** Create a preview bound to a model's declared parameters. @param {object} parent Placement group. @param {object} model Saved model and builder. @param {object} spec Validated controls. @returns {object} Update and disposal methods. */
export function createParameterPreview(parent, model, spec) {
  if (!model.generate || !model.parameters || Object.keys(spec.values).some(key => !Object.hasOwn(model.parameters, key))) throw new Error('Controls must bind declared model parameters')
  let preview = null, previous = null, generation = 0, closed = false, pending = Promise.resolve(), requested = null
  const visible = model.root.visible
  return {
    update(values) {
      const checked = controlValues(spec, values), key = JSON.stringify(checked)
      if (key === requested) return pending
      requested = key
      const request = ++generation
      const work = pending.catch(() => {}).then(async () => {
        if (closed || request !== generation) return false
        if (key === previous) return true
        const artifact = await model.generate({ ...model.parameters, ...checked })
        if (closed || request !== generation) return false
        const next = await parseGlbModel(artifact.bytes)
        if (closed || request !== generation) { disposeModel(next.root); return false }
        if (preview) { parent.remove(preview.root); disposeModel(preview.root) }
        preview = next; previous = key
        model.root.visible = false; parent.add(next.root)
        return true
      })
      void work.catch(() => { if (request === generation) requested = null })
      pending = work
      return work
    },
    dispose() {
      closed = true; generation++
      if (preview) { parent.remove(preview.root); disposeModel(preview.root); preview = null }
      model.root.visible = visible
      return pending.catch(() => {})
    },
  }
}
