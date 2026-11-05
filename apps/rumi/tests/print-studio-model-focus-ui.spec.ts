// @vitest-environment jsdom
/** Viewing a model and working on a model are independent visible states. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createModelSelector } from '../brand/print-studio/viewer/model-selector.js'
import { en } from '../brand/print-studio/viewer/locales.js'

it('marks the working model independently of selection and removes the dot when work clears', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), root = createRoot(container), select = vi.fn()
  const Selector = createModelSelector(React, 'button')
  const render = (workingModels: string[], selectedModel = 'dragon') => root.render(React.createElement(Selector, {
    scene: { models: [{ name: 'Cup', path: 'cup' }, { name: 'Dragon', path: 'dragon' }], selectedModel, workingModels },
    busy: false, select, t: (key: keyof typeof en) => en[key],
  }))
  try {
    await act(async () => render(['cup']))
    const [cup, dragon] = container.querySelectorAll('button')
    expect(cup?.querySelector('.pv-working-dot')).not.toBeNull()
    expect(cup?.getAttribute('aria-pressed')).toBe('false')
    expect(cup?.getAttribute('aria-label')).toBe('Cup: Rumi is working on this model')
    expect(dragon?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => cup?.click())
    expect(select).toHaveBeenCalledWith('cup')
    await act(async () => render(['cup'], 'cup'))
    expect(container.querySelectorAll('.pv-working-dot')).toHaveLength(1)
    await act(async () => render([]))
    expect(container.querySelector('.pv-working-dot')).toBeNull()
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals() }
})
