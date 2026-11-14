/** Layout controls retain keyboard actions, failure recovery and localized plate destinations. */
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createPrintLayoutPanel } from '../viewer/print-layout/panel.js'
import { Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { en, zh } from '../viewer/locales.js'

const Button = ({ children, variant: _variant, size: _size, ...props }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props}>{children}</button>
const Panel = createPrintLayoutPanel(React, { Button, Menu, IconChevronDownOutlineRegular })
afterEach(cleanup)

it.each(['en', 'zh'] as const)('exposes keyboard placement, undo and handoff actions in %s', (locale) => {
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, values: Record<string, string | number> = {}) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]))
  const state = { active: true, manufacturingMode: 'separate', plate: 0, selected: 'door', canUndo: true, issues: [],
    parts: [{ id: 'door', name: 'Door' }, { id: 'base', name: 'Base' }],
    layout: { volume: { x: 300, y: 320, z: 320 }, gap: 5, parts: [{ id: 'door', plate: 0 }, { id: 'base', plate: 1 }] } }
  const action = vi.fn()
  const result = render(<Panel state={state} available busy={false} message={null} t={t} action={action} />)
  expect(screen.queryByText(dictionary.layoutSeparate)).toBeNull()
  expect(screen.queryByRole('button', { name: dictionary.layoutMore })).toBeNull()
  expect(screen.queryByRole('button', { name: dictionary.layoutSave })).toBeNull()
  expect(screen.queryByRole('button', { name: dictionary.layoutOpen })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('layoutSelectedPart', { name: 'Door' }) }))
  fireEvent.click(screen.getByRole('menuitem', { name: dictionary.layoutRotateZ }))
  expect(action).toHaveBeenLastCalledWith('edit', { rotate: 2 })
  fireEvent.click(screen.getByRole('button', { name: dictionary.layoutReview }))
  expect(screen.getByText(dictionary.layoutChecksMissing)).toBeTruthy()
  expect(screen.getByText(dictionary.layoutPlacementFits)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: dictionary.layoutContinue }))
  fireEvent.click(screen.getByRole('button', { name: dictionary.layoutOpen }))
  expect(action).toHaveBeenLastCalledWith('export')
  result.rerender(<Panel state={{ ...state, issues: ['layoutOverlap'] }}
    available busy={false} message={null} t={t} action={action} />)
  expect(screen.getByRole('button', { name: dictionary.layoutOpen }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(dictionary.layoutOverlap)
  result.rerender(<Panel state={{ ...state, layout: { ...state.layout, gap: 6 } }}
    available busy={false} message={null} t={t} action={action} />)
  expect(screen.getByRole('button', { name: dictionary.layoutReview })).toBeTruthy()
  expect(screen.queryByRole('button', { name: dictionary.layoutOpen })).toBeNull()
})

it('offers a new unsaved layout when saved state cannot be read', () => {
  const action = vi.fn(), t = (key: keyof typeof en) => en[key]
  render(<Panel state={null} available busy={false} message="layoutFailed" t={t} action={action} />)
  fireEvent.click(screen.getByRole('button', { name: en.layoutFresh }))
  expect(action).toHaveBeenCalledWith('fresh')
})

it('explains legacy connector redesign without offering to relabel the model', () => {
  const action = vi.fn(), t = (key: keyof typeof en) => en[key]
  render(<Panel state={null} available busy={false} message="layoutSeparateRequired" t={t} action={action} />)
  expect(screen.getByRole('status').textContent).toBe(en.layoutSeparateRequired)
  expect(screen.queryByRole('button', { name: en.layoutFresh })).toBeNull()
})


it('keeps failed autosaves visible and offers retry without restoring a save menu', () => {
  const action = vi.fn(), t = (key: keyof typeof en) => en[key]
  const state = { active: true, plate: 0, parts: [], issues: [],
    layout: { identity: 'model', parts: [{ id: 'body', plate: 0 }], volume: { x: 300, y: 320, z: 320 }, gap: 5 } }
  render(<Panel state={state} available busy={false} message={null} saveStatus="error" t={t} action={action} />)
  expect(screen.getByRole('alert').textContent).toContain(en.layoutSaveFailed)
  fireEvent.click(screen.getByRole('button', { name: en.layoutRetrySave }))
  expect(action).toHaveBeenCalledWith('retry-save')
})
