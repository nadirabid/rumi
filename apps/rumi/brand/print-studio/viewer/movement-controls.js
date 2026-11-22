/** Show joint targets on the model and keep one reusable movement widget open. */

/**
 * Create the viewer's local pose controls.
 * @param {object} React Renderer primitives.
 * @param {object} primitives Shared client controls and symbols.
 * @param {Function} AnalogPanel Renderer for declared movement widgets.
 * @returns {Function} Movement controls component.
 */
export function createMovementControls(React, { Button, IconSlidersTwoOutlineRegular, IconChevronDownOutlineRegular }, AnalogPanel) {
  const h = React.createElement

  function position(element, point) {
    element.style.setProperty('--pv-joint-x', `${point.x.toFixed(2)}%`)
    element.style.setProperty('--pv-joint-y', `${point.y.toFixed(2)}%`)
  }

  return function MovementControls({ spec, viewport, stage, disabled, hidden, onError, t }) {
    const [open, setOpen] = React.useState(true)
    const [selected, setSelected] = React.useState(null)
    const root = React.useRef(null), trigger = React.useRef(null)
    const rings = React.useRef([]), popover = React.useRef(null)
    const interactive = open && !disabled && !hidden
    const groupId = React.useId()
    const number = React.useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }), [])

    function close() {
      setSelected(null)
      setOpen(false)
    }

    React.useEffect(() => {
      if (disabled || hidden) setSelected(null)
    }, [disabled, hidden])

    React.useLayoutEffect(() => {
      if (!interactive) return
      const panelWidth = popover.current?.offsetWidth ?? 0
      return viewport.current?.observeMotionAnchors(spec.id, (points, width) => {
        for (const [index, ring] of rings.current.entries()) {
          if (!ring) continue
          const point = points[index]
          ring.hidden = !point || point.x < 3 || point.x > 97 || point.y < 8 || point.y > 92
          if (!ring.hidden) position(ring, point)
        }
        const panel = popover.current
        if (!panel || panel.matches(':has(input:active, .av-pad:active, .av-curve:active)')) return
        const anchor = rings.current[selected]?.hidden ? null : points[selected]
        panel.toggleAttribute('data-anchored', Boolean(anchor))
        if (!anchor) return
        position(panel, anchor)
        const left = width * anchor.x / 100, right = width - left
        const space = panelWidth + 32
        panel.toggleAttribute('data-left', left >= space && (left < right || right < space))
        panel.toggleAttribute('data-above', anchor.y > 50)
      }, selected === null ? undefined : () => setSelected(null))
    }, [interactive, selected, spec.id, viewport])

    React.useLayoutEffect(() => {
      if (interactive && selected !== null) popover.current?.querySelector('input, [tabindex="0"]')?.focus({ preventScroll: true })
    }, [interactive, selected])

    React.useEffect(() => {
      if (!interactive) return
      const element = root.current
      const document = element.ownerDocument
      function dismiss(event) {
        if (!element.contains(event.target) && !stage.current?.contains(event.target)) setSelected(null)
      }
      function escape(event) {
        if (event.key !== 'Escape' || !element.closest('.pv-content').contains(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        close()
        trigger.current?.focus({ preventScroll: true })
      }
      document.addEventListener('pointerdown', dismiss)
      document.addEventListener('keydown', escape)
      return () => {
        document.removeEventListener('pointerdown', dismiss)
        document.removeEventListener('keydown', escape)
      }
    }, [interactive, stage])

    function change(values) {
      try { return viewport.current?.updateMotion(values, { id: spec.id, deferDraw: true }) ?? false }
      catch (_error) { onError(); return false }
    }

    function formatValue(axis, value) {
      const formatted = number.format(value)
      return viewport.current?.motionUnit?.(axis.key) === 'degree' ? `${formatted}°` : t('motionMillimeters', { value: formatted })
    }

    return h('div', { ref: root, className: 'pv-movement', hidden },
      h(Button, {
        ref: trigger, className: 'pv-movement-trigger', variant: 'ghost', size: 'sm', disabled,
        icon: IconSlidersTwoOutlineRegular && h(IconSlidersTwoOutlineRegular, { size: 14 }),
        'aria-expanded': interactive, 'aria-controls': interactive ? groupId : undefined,
        onClick: () => { if (open) close(); else setOpen(true) },
      }, t('motionControls')),
      interactive && h(React.Fragment, null,
        h('label', { className: 'pv-movement-picker rumi-region-glass' },
          h('select', {
            'aria-label': t('motionChooseJoint'), value: selected ?? '',
            onChange: event => setSelected(event.currentTarget.value === '' ? null : Number(event.currentTarget.value)),
          }, h('option', { value: '' }, t('motionChooseJoint')),
          spec.controls.map((control, index) => h('option', { key: control.axes[0].key, value: index }, control.label))),
          IconChevronDownOutlineRegular && h(IconChevronDownOutlineRegular, { size: 12, 'aria-hidden': true })),
        h('div', { className: 'pv-joint-targets', id: groupId, role: 'group', 'aria-label': t('motionControls') },
          spec.controls.map((control, index) => h('button', {
            key: control.axes[0].key, ref: element => { rings.current[index] = element },
            type: 'button', className: 'pv-joint-target', hidden: true, title: control.label,
            'aria-label': control.label, 'aria-pressed': selected === index,
            onClick: () => setSelected(selected === index ? null : index),
          })))),
      h('div', { ref: popover, className: 'pv-joint-popover rumi-region-glass', hidden: !interactive || selected === null },
        h(AnalogPanel, {
          spec, t, controlIndex: interactive ? selected : null, formatValue, onChange: change, onRelease: () => {},
        })))
  }
}
