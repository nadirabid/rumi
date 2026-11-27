/** Analog mesh-edit deformer controller: lifecycle, throttled frame updates, and latency metrics. */
import { createFieldPreview } from '../analog/field-preview.js'
import { createSurfacePreview } from '../analog/surface.js'
import { createShapeDeformer } from '../analog/gpu.js'
import { createParameterPreview } from '../analog/parameters.js'

/**
 * Own temporary analog deformer state, guide visibility, and animation-frame updates.
 * @param {object} host Viewport callbacks and shared scene hooks.
 * @returns {object} Shape control operations.
 */
export function createShapeController(host) {
  let deformer = null, shapeId = null, operation = null, frameId = null, values = null, inputTime = 0
  const metrics = { frames: 0, maxInputToDrawMs: 0, lastDrawMs: 0 }

  function clear() {
    if (frameId !== null) cancelAnimationFrame(frameId)
    frameId = null
    if (deformer) {
      host.hover.replacePin(null)
      host.track(Promise.resolve(deformer.dispose()))
    }
    deformer = null; shapeId = null; operation = null
  }

  return {
    get active() { return Boolean(deformer) },
    clear,
    setGuideVisible(visible) {
      deformer?.setGuideVisible?.(visible)
    },
    metrics: () => ({ ...metrics }),
    async apply(spec) {
      if (spec && host.isPrintActive()) host.clearPrint()
      if (!spec) { clear(); host.onCleared(); return null }
      host.clearMotion()
      const design = host.getDesign()
      if (!design) throw new Error('Load the model before its shape controls')
      if (spec.id !== shapeId) {
        clear()
        host.hover.clear()
        host.syncHighlight()
        deformer = spec.operation === 'fields'
          ? createFieldPreview(design.root, spec)
          : spec.operation === 'parameters'
            ? createParameterPreview(host.designRoot, design, spec)
            : spec.operation === 'surface'
              ? createSurfacePreview(design.root, spec)
              : createShapeDeformer(design.root, spec)
        shapeId = spec.id
        operation = spec.operation
        metrics.frames = 0; metrics.maxInputToDrawMs = 0; metrics.lastDrawMs = 0
      }
      deformer.setGuideVisible?.(!spec.frozen && host.isHighlightVisible())
      const owner = deformer
      const updated = await host.track(Promise.resolve(owner.update(spec.values)))
      if (host.isClosed() || owner !== deformer || updated === false) return null
      host.render()
      return document.hidden ? null : shapeId
    },
    update(nextValues) {
      if (host.activity.mode !== 'idle') return false
      if (!deformer) return
      if (operation === 'parameters') {
        const owner = deformer
        return host.track(owner.update(nextValues).then(updated => {
          if (host.isClosed() || owner !== deformer || !updated) return false
          host.hover.replacePin(null)
          host.render()
          return true
        }))
      }
      values = nextValues
      inputTime = performance.now()
      if (frameId !== null) return
      frameId = requestAnimationFrame(() => {
        frameId = null
        if (!deformer || host.isClosed()) return
        const started = performance.now()
        deformer.update(values)
        host.hover.replacePin(null)
        host.render()
        metrics.frames++
        metrics.lastDrawMs = performance.now() - started
        metrics.maxInputToDrawMs = Math.max(metrics.maxInputToDrawMs, performance.now() - inputTime)
      })
    },
  }
}
