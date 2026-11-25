// @vitest-environment jsdom
/** The global badge page keeps each mechanism's project evidence visible across updates and retries. */
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installBadges } from '../badges/client.js'

beforeEach(() => { vi.useFakeTimers() })
const disposers: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture() {
  const entries = new Map<string, React.ComponentType<Record<string, unknown>>>()
  let copy: Record<string, string> = {}
  const service = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', service)
  installBadges({
    effect(run: () => () => void) { disposers.push(run()) },
    locale: { register(_ns: string, locales: { en: Record<string, string> }) { copy = locales.en; return () => {} } },
    slots: {
      inject(_name: string, register: () => void) { register() },
      register(options: { name: string; key?: string }, component: React.ComponentType<Record<string, unknown>>) {
        entries.set(options.key ?? options.name, component)
        return () => {}
      },
    },
  }, React, {
    Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>,
    Tooltip: ({ children }: React.PropsWithChildren) => children,
    IconChevronRightOutlineRegular: () => <svg />,
  })
  const t = (key: string, args: Record<string, string> = {}) => copy[key]!.replace(/\{(\w+)\}/g, (_all, name: string) => args[name]!)
  return { service, page: React.createElement(entries.get('print-studio-badges')!, { t }),
    toolbar: (openPage: (id: string, label: string) => void) => React.createElement(entries.get('rumi.projects.toolbar')!, {
      activePanel: 'print-studio-badges', openPage, t,
    }),
  }
}
const empty = { awards: [], pending: 0, failed: 0 }
const award = { id: 'one', kind: 'wheel-and-axle', earnedAt: '2026-11-22T12:00:00.000Z',
  projectName: 'Cart', evidence: 'A wheel rotates around the front axle.' }

it('opens the badge page from the medal and communicates the current selection', () => {
  const view = fixture()
  const open = vi.fn()
  render(view.toolbar(open))
  const button = screen.getByRole('button', { name: 'Badges' })
  expect(button.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(button)
  expect(open).toHaveBeenCalledWith('print-studio-badges', 'Badges')
})

it('updates the empty collection with earned badges and shows all contributing projects', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json(empty)).mockResolvedValueOnce(Response.json({
    awards: [award, { ...award, id: 'two', projectName: 'Trolley' }], pending: 0, failed: 0,
  }))
  render(page)
  await act(async () => {})
  expect(screen.getByText('Build a mechanism in a project to earn its badge.')).toBeTruthy()
  const cards = screen.getAllByRole('article')
  expect(cards).toHaveLength(6)
  expect(within(cards[0]!).getByRole('heading', { name: 'Barrel hinge' })).toBeTruthy()
  for (const card of cards) {
    expect(card.textContent).toBe(within(card).getByRole('heading').textContent)
    expect(card.querySelector('.rumi-badge-medallion svg')?.getAttribute('width')).toBe('54')
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByText('1 of 6 mechanical badges earned')).toBeTruthy()
  const card = screen.getByRole('heading', { name: 'Wheel and axle' }).closest('article')!
  expect(screen.getAllByRole('article')[0]).toBe(card)
  fireEvent.click(within(card).getByText('2 projects'))
  expect(card.querySelector('details')?.open).toBe(true)
  expect(within(card).getByRole('heading', { name: 'Cart' })).toBeTruthy()
  expect(within(card).getByRole('heading', { name: 'Trolley' })).toBeTruthy()
  expect(within(card).getAllByText(award.evidence)).toHaveLength(2)
})

it('lists earned badges by their first award across projects before the unearned catalog', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json({
    ...empty,
    awards: [
      { ...award, id: 'four', earnedAt: '2026-11-24T12:00:00.000Z', projectName: 'Second cart' },
      { ...award, id: 'three', kind: 'barrel-hinge', earnedAt: '2026-11-23T12:00:00.000Z' },
      { ...award, id: 'two', kind: 'dovetail-slide', earnedAt: '2026-11-23T12:00:00.000Z' },
      award,
    ],
  }))
  render(page)
  await act(async () => {})
  expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
    'Wheel and axle', 'Barrel hinge', 'Dovetail slide', 'Living hinge', 'Gear pair', 'Rack and pinion',
  ])
})

it('keeps awards during a failed refresh and retries the correct operation', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json({ awards: [award], pending: 0, failed: 1 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ awards: [award], pending: 0, failed: 1 }))
    .mockResolvedValueOnce(Response.json({ queued: 1 }))
    .mockResolvedValueOnce(Response.json({ awards: [award], pending: 1, failed: 0 }))
  render(page)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded')
  expect(screen.getByText('1 project')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toContain('Some designs still need a badge check.')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await act(async () => {})
  expect(service.mock.calls[3]?.[0]).toBe('/api/print-studio/badges/retry')
  expect(service.mock.calls[3]?.[1]?.method).toBe('POST')
  expect(screen.getByRole('status').textContent).toContain('Checking your latest designs')
})
