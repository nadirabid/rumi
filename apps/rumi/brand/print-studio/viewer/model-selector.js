/** Model navigation and the independently declared agent work indicator. */

/**
 * Bind the model selector to the host React runtime and shared button primitive.
 * @param {object} React Host React runtime.
 * @param {Function} Button Shared button primitive.
 * @returns {Function} Selector component.
 */
export function createModelSelector(React, Button) {
  const h = React.createElement
  return function ModelSelector({ scene, busy, select, t }) {
    if (!scene?.models?.length) return null
    return h('div', { className: 'pv-models', role: 'group', 'aria-label': t('models') },
      scene.models.map(model => {
        const working = scene.workingModels?.includes(model.path)
        return h(Button, {
          key: model.path, variant: 'ghost', size: 'sm', disabled: busy,
          className: 'pv-model-button', title: model.name,
          'aria-label': working ? `${model.name}: ${t('modelWorking')}` : model.name,
          'aria-pressed': scene.selectedModel === model.path,
          onClick: () => { void select(model.path) },
        }, h('span', { className: 'pv-model-name' }, model.name), working ? h('span', { className: 'pv-working-dot', 'aria-hidden': true }) : null)
      }))
  }
}
