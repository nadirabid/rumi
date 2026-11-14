/** Layout controls retain keyboard actions, failure recovery and localized plate destinations. */
import * as React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createPrintLayoutPanel } from '../viewer/print-layout/panel.js'
import { en, zh } from '../viewer/locales.js'

const Button = ({ children, variant: _variant, size: _size, ...props }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => <button {...props}>{children}</button>
const Panel = createPrintLayoutPanel(React, Button)
afterEach(cleanup)

it.each(['en', 'zh'] as const)('exposes keyboard placement, undo and handoff actions in %s', (locale) => {
  const dictionary = locale === 'en' ? en : zh
  const t = (key: keyof typeof en, values: Record<string, number> = {}) =>
    dictionary[key].replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]))
  const state = { active: true, manufacturingMode: 'separate', plate: 0, selected: 'door', canUndo: true, issues: [],
    parts: [{ id: 'door', name: 'Door' }, { id: 'base', name: 'Base' }],
    layout: { volume: { x: 300, y: 320, z: 320 }, gap: 5, parts: [{ id: 'door', plate: 0 }, { id: 'base', plate: 1 }] } }
  const action = vi.fn()
  const result = render(<Panel state={state} available busy={false} message={null} t={t} action={action} />)
  expect(screen.getByText(dictionary.layoutSeparate)).toBeTruthy()
  const turn = screen.getByRole('button', { name: dictionary.layoutRotateZ })
  turn.focus(); fireEvent.click(turn)
  expect(action).toHaveBeenLastCalledWith('edit', { rotate: 2 })
  fireEvent.click(screen.getByRole('button', { name: t('layoutMoveToPlate', { number: 2 }) }))
  expect(action).toHaveBeenLastCalledWith('edit', { plate: 1 })
  fireEvent.click(screen.getByRole('button', { name: dictionary.layoutOpen }))
  expect(action).toHaveBeenLastCalledWith('export')
  result.rerender(<Panel state={{ ...state, issues: ['layoutOverlap'] }} available busy={false} message={null} t={t} action={action} />)
  expect(screen.getByRole('button', { name: dictionary.layoutOpen }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(dictionary.layoutOverlap)
  expect(document.activeElement).toBe(turn)
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
