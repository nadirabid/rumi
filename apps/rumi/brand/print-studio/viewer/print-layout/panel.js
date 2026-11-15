/** Viewer-local print controls reuse the shell's controls and retain reversible placement. */

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
  function SaveFailure({ busy, t, action }) {
    return h('div', { className: 'pv-print-glass pv-print-notice', role: 'alert' },
      h('p', null, t('layoutSaveFailed')),
      h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => action('retry-save') }, t('layoutRetrySave')))
  }
  function Preparation({ state, busy, message, saveStatus, working, t, action }) {
    const plateCount = Math.max(...state.layout.parts.map(part => part.plate)) + 1
    const plateItems = Array.from({ length: plateCount }, (_, plate) => ({ id: String(plate), label: t('layoutPlate', { number: plate + 1 }) }))
    const button = (key, run, disabled = false, primary = false) => h(Button, { key, variant: primary ? 'primary' : 'ghost', size: 'sm',
      className: primary ? 'pv-print-primary' : undefined, disabled: busy || (working && key !== 'layoutBackToModel') || disabled, onClick: run }, t(key))
    const canOpen = state.issues.length === 0 && state.layout.parts.some(part => part.plate === state.plate)
    return h('div', { className: 'pv-print-flow', 'aria-busy': busy },
      h('div', { className: 'pv-print-top' },
        h('div', { className: 'pv-print-glass pv-print-back' }, button('layoutBackToModel', () => action('close')))),
      h('div', { className: 'pv-print-bottom' },
        state.issues.length > 0 && h('div', { className: 'pv-print-glass pv-print-notice', role: 'alert' }, state.issues.map(code => h('p', { key: code }, t(code)))),
        saveStatus === 'error' && h(SaveFailure, { busy, t, action }),
        message && h('p', { role: 'status', className: 'pv-print-glass pv-print-notice' }, t(message)),
        h('p', { className: 'pv-print-drag-hint' }, t('layoutDragHint')),
        h('div', { className: 'pv-print-glass pv-print-toolbar', role: 'group', 'aria-label': t('layoutWorkflow') },
          h(Choice, { label: t('layoutPlate', { number: state.plate + 1 }), items: plateItems, selectedId: String(state.plate), select: id => action('plate', Number(id)), busy: busy || working }),
          button('layoutAutoArrange', () => action('arrange')),
          button('layoutUndo', () => action('undo'), !state.canUndo),
          button('layoutOpen', () => action('export'), !canOpen, true))))
  }
  return function PrintLayoutPanel({ state, available, busy, message, saveStatus = 'idle', working = false, t, action }) {
    if (state?.active) return h(Preparation, { key: state.layout.identity, state, busy, message, saveStatus, working, t, action })
    return h('div', { className: 'pv-print-entry', 'aria-busy': busy },
      h(Button, { variant: 'ghost', size: 'sm', className: 'pv-model-button', disabled: busy || working || !available, onClick: () => action('open') }, t('layoutPrint')),
      saveStatus === 'error' && h(SaveFailure, { busy, t, action }),
      message === 'layoutFailed' && h(Button, { variant: 'ghost', size: 'sm', className: 'pv-model-button', disabled: busy, onClick: () => action('fresh') }, t('layoutFresh')),
      message && h('p', { role: 'status', className: 'pv-print-glass pv-print-notice' }, t(message)))
  }
}
