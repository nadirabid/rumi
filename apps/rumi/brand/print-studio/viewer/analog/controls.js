/** Continuous controls on independent floating glass surfaces. */
export function createAnalogPanel(React) {
  const h = React.createElement
  const clamp = value => Math.max(0, Math.min(1, value))
  return function AnalogPanel({ spec, t, onChange, onRelease }) {
    const [values, setValues] = React.useState(spec.values)
    const current = React.useRef(spec.values)
    const dragging = React.useRef(false)
    const locked = spec.frozen || spec.freezeRequested
    // Host echoes cannot rewind a newer local gesture within the same control session.
    React.useEffect(() => { current.current = spec.values; setValues(spec.values) }, [spec.id])
    function update(patch) {
      if (locked) return
      current.current = { ...current.current, ...patch }
      setValues(current.current)
      onChange(current.current)
    }
    function release() {
      dragging.current = false
      if (!locked) onRelease(current.current)
    }
    const reset = (keys, label) => h('button', {
      type: 'button', className: 'av-reset', disabled: locked,
      title: t('shapeReset').replace('{control}', t(label)),
      'aria-label': t('shapeReset').replace('{control}', t(label)),
      onClick: () => { if (!locked) { update(Object.fromEntries(keys.map(key => [key, .5]))); release() } },
    }, h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M3 10a9 9 0 1 1 2.5 8.5M3 4v6h6' })))
    const slider = (key, label) => h('div', { className: 'av-glass av-slider', key },
      h('span', null, t(label)),
      h('input', {
        type: 'range', min: 0, max: 1, step: .001, value: values[key], disabled: locked,
        'aria-label': t(label), style: { '--av-value': `${values[key] * 100}%` },
        onPointerDown: () => { dragging.current = true },
        onInput: event => update({ [key]: Number(event.currentTarget.value) }),
        onPointerUp: release, onPointerCancel: release, onKeyUp: release,
        onBlur: () => { if (dragging.current) release() },
      }), reset([key], label))
    function point(event, kind) {
      const box = event.currentTarget.getBoundingClientRect()
      if (kind === 'pad') {
        update({ peakX: clamp((event.clientX - box.left) / box.width), peakY: clamp(1 - (event.clientY - box.top) / box.height) })
      } else {
        const height = clamp(1 - ((event.clientY - box.top) / box.height - .1) / .8)
        update({ falloff: clamp((Math.log(Math.max(.001, height)) / Math.log(.75) - 1.5) / 4) })
      }
    }
    const gestures = kind => ({
      onPointerDown: event => {
        if (locked || event.button !== 0) return
        dragging.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        point(event, kind)
        event.preventDefault()
      },
      onPointerMove: event => {
        if (!locked && dragging.current && event.currentTarget.hasPointerCapture(event.pointerId)) point(event, kind)
      },
      onPointerUp: event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
          release()
        }
      },
      onPointerCancel: event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
          release()
        }
      },
    })
    const exponent = 1.5 + 4 * values.falloff
    const curve = Array.from({ length: 49 }, (_, i) => {
      const x = i / 48
      return `${i ? 'L' : 'M'}${x * 100},${90 - 80 * Math.pow(Math.max(0, 1 - (2 * x - 1) ** 2), exponent)}`
    }).join(' ')
    if (spec.frozen) return h('div', { className: 'av-saving av-glass', role: 'status' }, t('shapeFrozen'))
    if (spec.operation === 'cut') return h('section', { className: 'av-controls', 'aria-label': `${t('shapeControls')}: ${spec.label}`, 'aria-busy': locked },
      slider('amount', 'cutHeight'), slider('angle', 'cutTilt'), slider('spread', 'cutLean'))
    return h('section', { className: 'av-controls', 'aria-label': `${t('shapeControls')}: ${spec.label}`, 'aria-busy': locked },
      slider('amount', 'shapeAmount'),
      slider('spread', 'shapeSpread'),
      spec.operation === 'bulge' ? slider('angle', 'shapeAngle') : null,
      h('div', { className: 'av-spatial' },
        h('div', { className: 'av-glass av-field' },
          h('div', { className: 'av-field-header' }, h('span', null, t('shapePeak')), reset(['peakX', 'peakY'], 'shapePeak')),
          h('div', {
            className: 'av-pad', role: 'group', 'aria-label': t('shapePeak'), 'aria-disabled': locked,
            tabIndex: locked ? -1 : 0, ...gestures('pad'),
            onKeyDown: event => {
              const delta = { ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, .02], ArrowDown: [0, -.02] }[event.key]
              if (!delta || locked) return
              event.preventDefault()
              update({ peakX: clamp(current.current.peakX + delta[0]), peakY: clamp(current.current.peakY + delta[1]) })
              release()
            },
          },
          h('span', { className: 'av-cross av-cross-x' }), h('span', { className: 'av-cross av-cross-y' }),
          h('span', { className: 'av-handle', style: { left: `${values.peakX * 100}%`, top: `${(1 - values.peakY) * 100}%` } }))),
        h('div', { className: 'av-glass av-field' },
          h('div', { className: 'av-field-header' }, h('span', null, t('shapeCurve')), reset(['falloff'], 'shapeCurve')),
          h('div', {
            className: 'av-curve', role: 'slider', tabIndex: locked ? -1 : 0,
            'aria-label': t('shapeCurve'), 'aria-valuemin': 0, 'aria-valuemax': 100,
            'aria-valuenow': Math.round(values.falloff * 100), 'aria-disabled': locked, ...gestures('curve'),
            onKeyDown: event => {
              if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || locked) return
              event.preventDefault()
              update({ falloff: clamp(current.current.falloff + (['ArrowUp', 'ArrowRight'].includes(event.key) ? .02 : -.02)) })
              release()
            },
          },
          h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true }, h('path', { d: curve, className: 'av-curve-line' })),
          h('span', { className: 'av-handle', style: { left: '75%', top: `${90 - 80 * Math.pow(.75, exponent)}%` } })))))
  }
}
