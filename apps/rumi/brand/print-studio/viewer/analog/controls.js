/** Labeled controls render declarations independently of the model operation. */
import { legacyControls } from './control-spec.js'

/** Build the shared control panel. @param {object} React Renderer primitives. @returns {Function} Control panel component. */
export function createAnalogPanel(React) {
  const h = React.createElement
  const clamp = value => Math.max(0, Math.min(1, value))
  const fraction = (axis, value) => (value - axis.min) / (axis.max - axis.min)
  const fromFraction = (axis, value) => Math.max(axis.min, Math.min(axis.max, axis.min + Math.round(clamp(value) * (axis.max - axis.min) / axis.step) * axis.step))
  return function AnalogPanel({ spec, t, onChange, onRelease }) {
    const [values, setValues] = React.useState(spec.values)
    const current = React.useRef(spec.values), dragging = React.useRef(false)
    const locked = spec.frozen || spec.freezeRequested
    const definitions = spec.controls ?? legacyControls(spec.operation).map(control => ({ ...control, label: t(control.label) }))
    React.useEffect(() => { current.current = spec.values; setValues(spec.values) }, [spec.id])
    function update(patch) {
      if (locked) return
      const next = { ...current.current, ...patch }
      if (onChange(next) === false) return
      current.current = next; setValues(next)
    }
    function release() { dragging.current = false; if (!locked) onRelease(current.current) }
    function reset(control) {
      return h('button', {
        type: 'button', className: 'av-reset', disabled: locked,
        title: t('shapeReset').replace('{control}', control.label), 'aria-label': t('shapeReset').replace('{control}', control.label),
        onClick: () => { if (!locked) { update(Object.fromEntries(control.axes.map(axis => [axis.key, axis.reset]))); release() } },
      }, h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M3 10a9 9 0 1 1 2.5 8.5M3 4v6h6' })))
    }
    function point(event, control) {
      const box = event.currentTarget.getBoundingClientRect(), [x, y] = control.axes
      if (control.kind === 'pad') update({ [x.key]: fromFraction(x, (event.clientX - box.left) / box.width), [y.key]: fromFraction(y, 1 - (event.clientY - box.top) / box.height) })
      else {
        const height = clamp(1 - ((event.clientY - box.top) / box.height - .1) / .8)
        update({ [x.key]: fromFraction(x, (Math.log(Math.max(.001, height)) / Math.log(.75) - 1.5) / 4) })
      }
    }
    function gestures(control) {
      return {
        onPointerDown: event => { if (!locked && event.button === 0) { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); point(event, control); event.preventDefault() } },
        onPointerMove: event => { if (!locked && dragging.current && event.currentTarget.hasPointerCapture(event.pointerId)) point(event, control) },
        onPointerUp: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); release() } },
        onPointerCancel: event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); release() } },
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
    function render(control) {
      const [x, y] = control.axes, key = control.axes.map(axis => axis.key).join(':')
      if (control.kind === 'slider') return h('div', { className: 'av-glass av-slider', key },
        h('span', null, control.label), h('input', {
          type: 'range', min: x.min, max: x.max, step: x.step, value: values[x.key], disabled: locked,
          'aria-label': control.label, style: { '--av-value': `${fraction(x, values[x.key]) * 100}%` },
          onPointerDown: () => { dragging.current = true }, onInput: event => update({ [x.key]: Number(event.currentTarget.value) }),
          onPointerUp: release, onPointerCancel: release, onKeyUp: release, onBlur: () => { if (dragging.current) release() },
        }), reset(control))
      const normalized = fraction(x, values[x.key]), exponent = 1.5 + 4 * normalized
      const curve = Array.from({ length: 49 }, (_, i) => `${i ? 'L' : 'M'}${i / 48 * 100},${90 - 80 * Math.pow(Math.max(0, 1 - (2 * i / 48 - 1) ** 2), exponent)}`).join(' ')
      return h('div', { className: 'av-glass av-field', key },
        h('div', { className: 'av-field-header' }, h('span', null, control.label), reset(control)),
        h('div', {
          className: control.kind === 'pad' ? 'av-pad' : 'av-curve', role: control.kind === 'pad' ? 'group' : 'slider',
          tabIndex: locked ? -1 : 0, 'aria-label': control.label, 'aria-disabled': locked,
          ...(control.kind === 'curve' ? { 'aria-valuemin': x.min, 'aria-valuemax': x.max, 'aria-valuenow': values[x.key] } : {}),
          ...gestures(control),
        }, control.kind === 'pad' ? [
          h('span', { key: 'x', className: 'av-cross av-cross-x' }), h('span', { key: 'y', className: 'av-cross av-cross-y' }),
          h('span', { key: 'handle', className: 'av-handle', style: { left: `${normalized * 100}%`, top: `${(1 - fraction(y, values[y.key])) * 100}%` } }),
        ] : [
          h('svg', { key: 'curve', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true }, h('path', { d: curve, className: 'av-curve-line' })),
          h('span', { key: 'handle', className: 'av-handle', style: { left: '75%', top: `${90 - 80 * Math.pow(.75, exponent)}%` } }),
        ]))
    }
    if (spec.frozen) return h('div', { className: 'av-saving av-glass', role: 'status' }, t('shapeFrozen'))
    return h('section', { className: 'av-controls', 'aria-label': `${t('shapeControls')}: ${spec.label}`, 'aria-busy': locked }, definitions.map(render))
  }
}
