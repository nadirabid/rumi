/** Labeled controls render declarations independently of the model operation. */
import { legacyControls } from './control-spec.js'

/** Build the shared control panel. @param {object} React Renderer primitives. @returns {Function} Control panel component. */
export function createAnalogPanel(React) {
  const h = React.createElement
  const clamp = value => Math.max(0, Math.min(1, value))
  const fraction = (axis, value) => (value - axis.min) / (axis.max - axis.min)
  const fromFraction = (axis, value) => Math.max(axis.min, Math.min(axis.max, axis.min + Math.round(clamp(value) * (axis.max - axis.min) / axis.step) * axis.step))
  return function AnalogPanel({ spec, t, onChange, onRelease, controlIndex, formatValue }) {
    const [values, setValues] = React.useState(spec.values)
    const current = React.useRef(spec.values), dragging = React.useRef(false)
    const committed = React.useRef(spec.values), sequence = React.useRef(0), pending = React.useRef(Promise.resolve())
    const locked = spec.frozen || spec.freezeRequested
    const definitions = spec.controls ?? legacyControls(spec.operation).map(control => ({ ...control, label: t(control.label) }))
    React.useEffect(() => {
      sequence.current++; committed.current = spec.values; current.current = spec.values; setValues(spec.values)
      return () => { sequence.current++ }
    }, [spec.id])
    function update(patch) {
      if (locked) return
      const next = { ...current.current, ...patch }
      const request = ++sequence.current, outcome = onChange(next)
      if (outcome === false) return
      current.current = next; setValues(next)
      if (outcome && typeof outcome.then === 'function') {
        pending.current = Promise.resolve(outcome).then(accepted => {
          if (accepted !== false) committed.current = next
          else if (request === sequence.current) { current.current = committed.current; setValues(committed.current) }
        }, () => {
          if (request === sequence.current) { current.current = committed.current; setValues(committed.current) }
        })
      } else committed.current = next
    }
    function release() {
      dragging.current = false
      const request = sequence.current
      void pending.current.then(() => { if (!locked && request === sequence.current) onRelease(current.current) })
    }
    function resetControl(control) {
      if (locked) return
      update(Object.fromEntries(control.axes.map(axis => [axis.key, axis.reset])))
      release()
    }
    function isDirty(control) {
      return control.axes.some(axis => Math.abs(values[axis.key] - axis.reset) > 1e-6)
    }
    function reset(control, valueText) {
      const dirty = isDirty(control)
      const label = t('shapeReset').replace('{control}', control.label)
      const action = t('shapeResetAction')
      return h('button', {
        type: 'button', className: 'av-reset', disabled: locked,
        'data-dirty': dirty ? 'true' : 'false',
        'data-has-value': valueText ? 'true' : 'false',
        title: label, 'aria-label': label,
        onClick: () => resetControl(control),
      },
      valueText
        ? h('output', { className: 'av-reset-value', 'aria-hidden': true }, valueText)
        : h('span', { className: 'av-reset-dot', 'aria-hidden': true }),
      h('span', { className: 'av-reset-label', 'aria-hidden': true }, action))
    }
    function point(event, control) {
      const box = event.currentTarget.getBoundingClientRect(), [x, y] = control.axes
      if (control.kind === 'pad') update({ [x.key]: fromFraction(x, (event.clientX - box.left) / box.width), [y.key]: fromFraction(y, 1 - (event.clientY - box.top) / box.height) })
      else {
        update({ [x.key]: fromFraction(x, (.9 - (event.clientY - box.top) / box.height) / .8) })
      }
    }
    function gestures(control) {
      return {
        onPointerDown: event => { if (!locked && event.button === 0) { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); point(event, control); event.preventDefault() } },
        onPointerMove: event => { if (!locked && dragging.current && event.currentTarget.hasPointerCapture(event.pointerId)) point(event, control) },
        onPointerUp: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); release() } },
        onPointerCancel: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); release() } },
        onDoubleClick: () => resetControl(control),
        onKeyDown: event => {
          const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key]
          if (!delta || locked) return
          event.preventDefault()
          const [x, y] = control.axes
          const change = axis => Math.max(1, Math.round((axis.max - axis.min) * .02 / axis.step)) * axis.step
          const bound = (axis, value) => Math.max(axis.min, Math.min(axis.max, value))
          update(control.kind === 'pad'
            ? { [x.key]: bound(x, current.current[x.key] + delta[0] * change(x)), [y.key]: bound(y, current.current[y.key] + delta[1] * change(y)) }
            : { [x.key]: bound(x, current.current[x.key] + (delta[0] || delta[1]) * change(x)) })
          release()
        },
      }
    }
    function renderControl(control) {
      const [x, y] = control.axes, key = control.axes.map(axis => axis.key).join(':')
      const valueText = formatValue?.(x, values[x.key])
      if (control.kind === 'slider') {
        const valueFraction = fraction(x, values[x.key])
        const resetFraction = fraction(x, x.reset)
        const hasOriginDetent = x.reset > x.min && x.reset < x.max
        const fillStart = hasOriginDetent && x.min < 0 && x.max > 0 ? Math.min(resetFraction, valueFraction) : 0
        const fillEnd = hasOriginDetent && x.min < 0 && x.max > 0 ? Math.max(resetFraction, valueFraction) : valueFraction
        return h('div', { className: 'av-slider', key },
          h('div', { className: 'av-control-header' },
            h('span', { className: 'av-label' }, control.label),
            reset(control, valueText)),
          h('div', { className: 'av-slider-wrap' },
            hasOriginDetent && h('span', {
              className: 'av-slider-detent', 'aria-hidden': true,
              style: { left: `calc(14px + (100% - 28px) * ${resetFraction})` },
            }),
            h('input', {
              type: 'range', min: x.min, max: x.max, step: x.step, value: values[x.key], disabled: locked,
              'aria-label': control.label, 'aria-valuetext': valueText,
              style: {
                '--av-value': `${valueFraction * 100}%`,
                '--av-fill-start': `${fillStart * 100}%`,
                '--av-fill-end': `${fillEnd * 100}%`,
              },
              onPointerDown: () => { dragging.current = true },
              onInput: event => update({ [x.key]: Number(event.currentTarget.value) }),
              onDoubleClick: () => resetControl(control),
              onPointerUp: release, onPointerCancel: release, onKeyUp: release,
              onBlur: () => { if (dragging.current) release() },
            })))
      }
      const normalized = fraction(x, values[x.key])
      const curve = `M0 90 Q50 ${90 - 160 * normalized} 100 90`
      return h('div', { className: 'av-field', key },
        h('div', { className: 'av-control-header av-field-header' },
          h('span', { className: 'av-label' }, control.label),
          reset(control)),
        h('div', {
          className: control.kind === 'pad' ? 'av-pad' : 'av-curve', role: control.kind === 'pad' ? 'group' : 'slider',
          tabIndex: locked ? -1 : 0, 'aria-label': control.label, 'aria-disabled': locked,
          ...(control.kind === 'curve' ? { 'aria-orientation': 'vertical', 'aria-valuemin': x.min, 'aria-valuemax': x.max, 'aria-valuenow': values[x.key] } : {}),
          ...gestures(control),
        }, control.kind === 'pad' ? [
          h('span', { key: 'x', className: 'av-cross av-cross-x' }), h('span', { key: 'y', className: 'av-cross av-cross-y' }),
          h('span', { key: 'handle', className: 'av-handle', style: { left: `${normalized * 100}%`, top: `${(1 - fraction(y, values[y.key])) * 100}%` } }),
        ] : [
          h('svg', { key: 'curve', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true },
            h('path', { d: curve, className: 'av-curve-line' }),
            h('path', { d: `${curve} L100 100 L0 100 Z`, className: 'av-curve-fill' }),
            h('line', { x1: 0, y1: 90, x2: 100, y2: 90, className: 'av-curve-baseline' })),
          h('span', { key: 'handle', className: 'av-handle', style: { left: '50%', top: `${90 - 80 * normalized}%` } }),
        ]))
    }
    function renderItems(list) {
      const items = []
      let index = 0
      while (index < list.length) {
        const control = list[index]
        if (control.kind === 'slider') {
          items.push(renderControl(control))
          index++
          continue
        }
        const spatial = []
        while (index < list.length && list[index].kind !== 'slider') {
          spatial.push(list[index])
          index++
        }
        if (items.length > 0) items.push(h('div', { key: `divider-${index}`, className: 'av-divider', 'aria-hidden': true }))
        if (spatial.length >= 2) {
          items.push(h('div', { key: `spatial-${index}`, className: 'av-spatial' }, spatial.map(renderControl)))
        } else {
          items.push(renderControl(spatial[0]))
        }
      }
      return items
    }
    if (spec.frozen) return h('div', { className: 'av-saving av-glass', role: 'status' }, t('shapeFrozen'))
    const visible = controlIndex === undefined ? definitions : controlIndex === null ? [] : [definitions[controlIndex]]
    return h('section', {
      className: controlIndex === undefined ? 'av-controls av-glass' : 'av-controls',
      'aria-label': controlIndex === undefined ? `${t('shapeControls')}: ${spec.label}` : spec.label,
      'aria-busy': locked,
    }, renderItems(visible))
  }
}
