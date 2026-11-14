/** Viewer-local preparation steps reuse the shell's controls and retain reversible placement. */

/** Bind print preparation to the host React runtime and shared controls.
 * @param {object} React Shell React instance.
 * @param {object} primitives Shared Button, Menu and chevron icon components.
 * @returns {Function} Localized preparation component.
 */
export function createPrintLayoutPanel(React, { Button, Menu, IconChevronDownOutlineRegular }) {
  const h = React.createElement
  function Choice({ label, items, select, busy, selectedId, side = 'top' }) {
    const [open, setOpen] = React.useState(false)
    return h(Menu, { open: open && !busy, items, selectedId, side, portal: true, autoFocus: true,
      onClose: () => setOpen(false), onSelect: id => { setOpen(false); select(id) },
      anchor: h(Button, { variant: 'ghost', size: 'sm', disabled: busy, 'aria-haspopup': 'menu', 'aria-expanded': open && !busy,
        onClick: () => setOpen(!open), className: 'pv-print-choice' }, label, h(IconChevronDownOutlineRegular, { size: 14, className: 'pv-print-chevron' })) })
  }
  function Preparation({ state, busy, message, validation, t, action }) {
    const signature = JSON.stringify(state.layout)
    const [navigation, setNavigation] = React.useState({ step: 'arrange', signature })
    const step = navigation.signature === signature ? navigation.step : 'arrange'
    const go = next => setNavigation({ step: next, signature })
    const plateCount = Math.max(...state.layout.parts.map(part => part.plate)) + 1
    const selected = state.parts.find(part => part.id === state.selected)
    const plateItems = Array.from({ length: plateCount }, (_, plate) => ({ id: String(plate), label: t('layoutPlate', { number: plate + 1 }) }))
    const button = (key, run, disabled = false, primary = false) => h(Button, { key, variant: primary ? 'primary' : 'ghost', size: 'sm',
      className: primary ? 'pv-print-primary' : undefined, disabled: busy || disabled, onClick: run }, t(key))
    const canOpen = state.issues.length === 0 && state.layout.parts.some(part => part.plate === state.plate)
    const adjustments = [
      ...['X', 'Y', 'Z'].map((axis, index) => ({ id: `rotate:${index}`, label: t(`layoutRotate${axis}`) })),
      { id: 'move', label: t('layoutNudge'), submenu: ['layoutLeft', 'layoutRight', 'layoutBack', 'layoutForward'].map((key, index) => ({ id: `move:${index}`, label: t(key) })) },
      { id: 'plate', label: t('layoutMove'), submenu: [...plateItems.map(item => ({ ...item, id: `plate:${item.id}`,
        disabled: state.layout.parts.find(part => part.id === state.selected)?.plate === Number(item.id) })),
      { id: `plate:${plateCount}`, label: t('layoutNextPlate'), disabled: plateCount >= 128 }] },
    ]
    const adjust = id => {
      const [kind, index] = id.split(':')
      const value = Number(index)
      action('edit', kind === 'rotate' ? { rotate: value } : kind === 'plate' ? { plate: value } : { move: [[-1, 0], [1, 0], [0, 1], [0, -1]][value] })
    }
    return h('div', { className: 'pv-print-flow', 'aria-busy': busy, 'data-step': step },
      h('div', { className: 'pv-print-top' },
        h('div', { className: 'pv-print-glass pv-print-back' }, button('layoutBackToModel', () => action('close'))),
        h('nav', { className: 'pv-print-glass pv-print-steps', 'aria-label': t('layoutWorkflow') },
          ['arrange', 'check', 'open'].map((value, index) => h(Button, { key: value, variant: 'ghost', size: 'sm',
            'aria-current': value === step ? 'step' : undefined, disabled: busy || (value === 'open' && (step === 'arrange' || !canOpen)),
            onClick: () => go(value) }, h('span', { className: 'pv-print-step-number', 'aria-hidden': true }, index + 1), t(`layoutStep_${value}`))))),
      h('div', { className: 'pv-print-bottom' },
        step === 'arrange' && selected && h('div', { className: 'pv-print-glass pv-print-selected' },
          h(Choice, { key: selected.id, label: t('layoutSelectedPart', { name: selected.name ?? t('layoutAssembly') }), items: adjustments, select: adjust, busy })),
        step === 'check' && h('section', { className: 'pv-print-glass pv-print-review', 'aria-label': t('layoutReview') },
          h('h3', null, t('layoutReview')),
          h('p', null, t('layoutDimensions', { ...state.layout.volume, gap: state.layout.gap })),
          h('div', { className: 'pv-print-check-row' }, h('span', null, t('layoutPlacement')), h('span', null, t(state.issues.length ? 'layoutPlacementReview' : 'layoutPlacementFits'))),
          h('div', { className: 'pv-print-check-row' }, h('span', null, t('layoutModelChecks')), h('span', null, t(validation))),
          h('p', null, t('layoutChecksScope'))),
        step === 'open' && h('section', { className: 'pv-print-glass pv-print-review', 'aria-label': t('layoutStep_open') },
          h('h3', null, t('layoutOpenTitle')),
          h('p', null, t('layoutOpenHint'))),
        state.issues.length > 0 && h('div', { className: 'pv-print-glass pv-print-notice', role: 'alert' }, state.issues.map(code => h('p', { key: code }, t(code)))),
        message && h('p', { role: 'status', className: 'pv-print-glass pv-print-notice' }, t(message)),
        step === 'arrange' && h('p', { className: 'pv-print-drag-hint' }, t('layoutDragHint')),
        h('div', { className: 'pv-print-glass pv-print-toolbar', role: 'group', 'aria-label': t('layoutWorkflow') },
          h(Choice, { label: t('layoutPlate', { number: state.plate + 1 }), items: plateItems, selectedId: String(state.plate), select: id => action('plate', Number(id)), busy }),
          step === 'arrange' && button('layoutAutoArrange', () => action('arrange')),
          step === 'arrange' && button('layoutUndo', () => action('undo'), !state.canUndo),
          h(Choice, { label: t('layoutMore'), busy, items: [
            { id: 'parts', label: t('layoutParts'), submenu: state.parts.map(part => ({ id: `part:${part.id}`, label: part.name ?? t('layoutAssembly') })) },
            { id: 'save', label: t('layoutSave') },
          ], select: id => { if (id === 'save') action('save'); else { action('select', id.slice(5)); go('arrange') } } }),
          step === 'arrange' ? button('layoutReview', () => go('check'), false, true)
            : step === 'check' ? button('layoutContinue', () => go('open'), !canOpen, true)
              : button('layoutOpen', () => action('export'), !canOpen, true))))
  }
  return function PrintLayoutPanel({ state, available, busy, message, validation = 'layoutChecksMissing', t, action }) {
    if (state?.active) return h(Preparation, { key: state.layout.identity, state, busy, message, validation, t, action })
    return h('div', { className: 'pv-print-entry', 'aria-busy': busy },
      h(Button, { variant: 'ghost', size: 'sm', className: 'pv-model-button', disabled: busy || !available, onClick: () => action('open') }, t('layoutPrint')),
      message === 'layoutFailed' && h(Button, { variant: 'ghost', size: 'sm', className: 'pv-model-button', disabled: busy, onClick: () => action('fresh') }, t('layoutFresh')),
      message && h('p', { role: 'status', className: 'pv-print-glass pv-print-notice' }, t(message)))
  }
}
