/** Localized controls for reversible print placement; all geometry stays in the viewport. */

/** Build the panel with the shell's React and shared button primitive.
 * @param {object} React Shell React instance.
 * @param {object} Button Shared button component.
 * @returns {Function} Stable panel component.
 */
export function createPrintLayoutPanel(React, Button) {
  const h = React.createElement
  return function PrintLayoutPanel({ state, available, busy, message, t, action }) {
    const active = state?.active === true
    const button = (key, run, disabled = false, extra = {}) => h(Button, { key, variant: key === 'layoutOpen' ? 'primary' : 'outline', size: 'sm', disabled: busy || disabled, onClick: run, ...extra }, t(key))
    const plateCount = active ? Math.max(...state.layout.parts.map(part => part.plate)) + 1 : 0
    return h('div', { className: 'pv-print-controls', 'aria-busy': busy },
      h('div', { className: 'pv-print-row', role: 'group', 'aria-label': t('layoutView') },
        button('layoutAssembled', () => { if (active) action('close') }, false, { className: 'pv-model-button', 'aria-pressed': !active }),
        button('layoutPrint', () => { if (!active) action('open') }, !available, { className: 'pv-model-button', 'aria-pressed': active })),
      active && h(React.Fragment, null,
        h('p', { className: 'pv-print-hint' }, t('layoutHint')),
        state.manufacturingMode === 'separate' && h('p', { className: 'pv-print-hint' }, t('layoutSeparate')),
        h('p', { className: 'pv-print-hint' }, t('layoutDimensions', { x: state.layout.volume.x, y: state.layout.volume.y, z: state.layout.volume.z, gap: state.layout.gap })),
        h('div', { className: 'pv-print-row', role: 'group', 'aria-label': t('layoutPlates') },
          Array.from({ length: plateCount }, (_, plate) => h(Button, { key: plate, className: 'pv-model-button', size: 'sm', variant: 'ghost', disabled: busy,
            'aria-pressed': plate === state.plate, onClick: () => action('plate', plate) }, t('layoutPlate', { number: plate + 1 })))),
        h('div', { className: 'pv-print-row', role: 'group', 'aria-label': t('layoutParts') },
          state.parts.map(part => h(Button, { key: part.id, className: 'pv-model-button', size: 'sm', variant: 'ghost', disabled: busy,
            title: part.name ?? t('layoutAssembly'), 'aria-pressed': part.id === state.selected,
            onClick: () => action('select', part.id) }, part.name ?? t('layoutAssembly')))),
        h('div', { className: 'pv-print-row', role: 'group', 'aria-label': t('layoutAdjust') },
          ['X', 'Y', 'Z'].map((axis, index) => button(`layoutRotate${axis}`, () => action('edit', { rotate: index }))),
          button('layoutLeft', () => action('edit', { move: [-1, 0] })), button('layoutRight', () => action('edit', { move: [1, 0] })),
          button('layoutBack', () => action('edit', { move: [0, 1] })), button('layoutForward', () => action('edit', { move: [0, -1] })),
          ...Array.from({ length: plateCount }, (_, plate) => h(Button, { key: `move-${plate}`, size: 'sm', variant: 'outline', disabled: busy || state.layout.parts.find(part => part.id === state.selected).plate === plate, onClick: () => action('edit', { plate }) }, t('layoutMoveToPlate', { number: plate + 1 }))),
          button('layoutNextPlate', () => action('edit', { plate: plateCount }), plateCount >= 128)),
        h('div', { className: 'pv-print-row' },
          button('layoutArrange', () => action('arrange')),
          button('layoutUndo', () => action('undo'), !state.canUndo),
          button('layoutSave', () => action('save')),
          button('layoutOpen', () => action('export'), state.issues.length > 0 || !state.layout.parts.some(part => part.plate === state.plate))),
        state.issues.map(code => h('p', { key: code, role: 'alert', className: 'pv-print-hint' }, t(code)))),
      !active && message === 'layoutFailed' && button('layoutFresh', () => action('fresh')),
      message && h('p', { role: 'status', className: 'pv-print-hint' }, t(message)))
  }
}
