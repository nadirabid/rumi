// @vitest-environment jsdom
/** The global badge page keeps each mechanism's project evidence visible across updates and retries. */
import * as React from 'react'
import { createPortal } from 'react-dom'
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

class AwardStream extends EventTarget {
  close = vi.fn()

  earned(...awards: Array<{ id: string; kind: string; path?: 'practice' | 'growth' }>) {
    this.dispatchEvent(new MessageEvent('badge-earned', {
      data: JSON.stringify({ projectId: 'cart', projectName: 'Cart', awards }),
    }))
  }
}

function fixture(language: 'en' | 'zh' = 'en') {
  const entries = new Map<string, React.ComponentType<Record<string, unknown>>>()
  let copy: Record<string, string> = {}
  const service = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', service)
  const stream = new AwardStream()
  const connect = vi.fn(function connect() { return stream })
  vi.stubGlobal('EventSource', connect)
  installBadges({
    effect(run: () => () => void) { disposers.push(run()) },
    locale: { register(_ns: string, locales: Record<'en' | 'zh', Record<string, string>>) { copy = locales[language]; return () => {} } },
    slots: {
      inject(_name: string, register: () => void) { register() },
      register(options: { name: string; key?: string }, component: React.ComponentType<Record<string, unknown>>) {
        entries.set(options.key ?? options.name, component)
        return () => {}
      },
    },
  }, React, {
    Button: ({ disabled, onClick, children, 'aria-label': label }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      <button disabled={disabled} onClick={onClick} aria-label={label}>{children}</button>,
    Tooltip: ({ children }: React.PropsWithChildren) => children,
    IconChevronRightOutlineRegular: () => <svg />,
    IconCloseOutlineRegular: () => <svg />,
  }, createPortal, (reference: string) => reference)
  const t = (key: string, args: Record<string, string> = {}) => copy[key]!.replace(/\{(\w+)\}/g, (_all, name: string) => args[name]!)
  return { service, stream, connect, page: React.createElement(entries.get('print-studio-badges')!, { t }),
    reveal: React.createElement(entries.get('shell.overlay')!, { t }),
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
    awards: [{ ...award, id: 'two', projectName: 'Trolley', earnedAt: '2026-11-23T12:00:00.000Z' }, award], pending: 0, failed: 0,
  }))
  render(page)
  await act(async () => {})
  expect(screen.getByText('Build mechanisms and grow your maker habits in a project to earn badges.')).toBeTruthy()
  const cards = screen.getAllByRole('article')
  expect(cards).toHaveLength(9)
  expect(within(cards[0]!).getByRole('heading', { name: 'Barrel hinge' })).toBeTruthy()
  expect(document.querySelector('.rumi-badges-earned')).toBeNull()
  expect(document.querySelector('.rumi-badges-divider')).toBeNull()
  expect(document.querySelectorAll('.rumi-badges-unearned article')).toHaveLength(9)
  expect(screen.getByText('Mechanical')).toBeTruthy()
  expect(screen.getByText('Maker habits')).toBeTruthy()
  const artwork = new Set<string>()
  for (const card of cards) {
    expect(within(card).queryByText('Not yet earned')).toBeNull()
    expect(card.querySelector('.rumi-badge-face[data-locked]')).toBeTruthy()
    expect(card.querySelector('details')).toBeNull()
    const medal = card.querySelector<HTMLImageElement>('.rumi-badge-artwork')
    expect(medal?.alt).toBe('')
    expect(medal?.src).toMatch(/\.webp$/)
    artwork.add(medal!.src)
  }
  expect(artwork.size).toBe(cards.length)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByText('1 badge earned')).toBeTruthy()
  const earnedGroup = document.querySelector('.rumi-badges-earned')!
  const unearnedGroups = document.querySelector('.rumi-badges-unearned-groups')!
  expect(document.querySelector('.rumi-badges-divider')).toBeTruthy()
  expect(within(earnedGroup).getAllByRole('article')).toHaveLength(1)
  expect(within(unearnedGroups).getAllByRole('article')).toHaveLength(8)
  const card = screen.getByRole('heading', { name: 'Wheel and axle' }).closest('article')!
  expect(earnedGroup.contains(card)).toBe(true)
  expect(within(card).queryByText('Badge earned')).toBeNull()
  expect(card.querySelector('.rumi-badge-project')?.textContent).toBe('Trolley')
  fireEvent.click(within(card).getByText('2 projects'))
  expect(card.querySelector('details')?.open).toBe(true)
  expect(within(card).getByRole('heading', { name: 'Cart' })).toBeTruthy()
  expect(within(card).getByRole('heading', { name: 'Trolley' })).toBeTruthy()
  expect(within(card).getAllByText(award.evidence)).toHaveLength(2)
})

it.each([
  { kind: 'living-hinge', name: '柔性铰链', working: true, individual: false, path: undefined },
  { kind: 'wheel-and-axle', name: '车轮与轮轴', working: true, individual: false, path: undefined },
  { kind: 'language', name: '清晰表达', working: false, individual: true, path: 'practice' as const },
  { kind: 'patience', name: '耐心等待', working: false, individual: true, path: 'growth' as const },
  { kind: 'persistence', name: '坚持不懈', working: false, individual: true, path: 'practice' as const },
])('displays the earned $kind face identically in the collection and the celebration', async ({ kind, name, working, individual, path }) => {
  const { page, reveal, service, stream } = fixture('zh')
  const earned = { ...award, kind, working, ...(path ? { path } : {}) }
  service.mockImplementation(async () => Response.json({ ...empty, awards: [earned] }))
  render(<>{page}{reveal}</>)
  await act(async () => { stream.earned(earned) })

  const collection = screen.getByRole('region', { name: '徽章' })
  const card = within(collection).getByRole('heading', { name }).closest('article')!
  const face = card.querySelector<HTMLElement>('.rumi-badge-face')!
  expect(within(face).getByText('Cart')).toBeTruthy()
  expect(face.querySelector<HTMLImageElement>('.rumi-badge-artwork')?.src).toContain(`/${kind}.webp`)
  if (path === 'growth') expect(within(face).getByText('有进步')).toBeTruthy()
  else expect(within(face).queryByText('有进步')).toBeNull()
  const plate = screen.getByRole('complementary').querySelector('.rumi-badge-reveal-plate')!
  expect(face.isEqualNode(plate.querySelector('.rumi-badge-face'))).toBe(true)

  fireEvent.click(within(card).getByText(individual ? '查看原因' : '1 个项目'))
  expect(card.querySelector('details')?.open).toBe(true)
  if (working) expect(within(card).getByText('已检查活动情况')).toBeTruthy()
  else expect(within(card).queryByText('已检查活动情况')).toBeNull()
})

it('renders every earned habit demonstration and improvement as its own growing tile in chronological order', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json({
    ...empty,
    awards: [
      { ...award, id: 'p2', kind: 'patience', path: 'growth', earnedAt: '2026-11-24T12:00:00.000Z', projectName: 'Rocket', evidence: 'Settled down and waited for the fins to finish.' },
      { ...award, id: 'l1', kind: 'language', path: 'practice', earnedAt: '2026-11-23T12:00:00.000Z', projectName: 'Rocket', evidence: 'Specified exact fin counts and wall thickness.' },
      { ...award, id: 'p1', kind: 'patience', path: 'practice', earnedAt: '2026-11-22T12:00:00.000Z', projectName: 'Cart', evidence: 'Waited through three builds before changing the wheels.' },
    ],
  }))
  render(page)
  await act(async () => {})
  expect(screen.getByText('3 badges earned')).toBeTruthy()
  const earnedGroup = document.querySelector('.rumi-badges-earned')!
  const earnedCards = within(earnedGroup).getAllByRole('article')
  expect(earnedCards).toHaveLength(3)
  expect(earnedCards.map(c => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual([
    'Patience', 'Language', 'Patience',
  ])
  expect(within(earnedCards[0]!).queryByText('Improved')).toBeNull()
  expect(within(earnedCards[2]!).getByText('Improved')).toBeTruthy()
  fireEvent.click(within(earnedCards[2]!).getByText('See why'))
  expect(within(earnedCards[2]!).getByText('Settled down and waited for the fins to finish.')).toBeTruthy()
  // Only Persistence remains in unearned Maker habits once Patience and Language are earned.
  const habitsSection = document.querySelector('[data-category="habits"]')!
  expect(within(habitsSection).getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Persistence'])
})

it('lists earned mechanical and habit badges together by first award before categorized unearned groups', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json({
    ...empty,
    awards: [
      { ...award, id: 'four', earnedAt: '2026-11-24T12:00:00.000Z', projectName: 'Second cart' },
      { ...award, id: 'five', kind: 'patience', earnedAt: '2026-11-22T18:00:00.000Z', evidence: 'Waited through builds.' },
      { ...award, id: 'three', kind: 'barrel-hinge', earnedAt: '2026-11-23T12:00:00.000Z' },
      { ...award, id: 'two', kind: 'dovetail-slide', earnedAt: '2026-11-23T12:00:00.000Z' },
      award,
    ],
  }))
  render(page)
  await act(async () => {})
  expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual([
    'Wheel and axle', 'Patience', 'Barrel hinge', 'Dovetail slide',
    'Living hinge', 'Gear pair', 'Rack and pinion',
    'Language', 'Persistence',
  ])
  const mechanicalSection = document.querySelector('[data-category="mechanical"]')!
  const habitsSection = document.querySelector('[data-category="habits"]')!
  expect(within(mechanicalSection).getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual([
    'Living hinge', 'Gear pair', 'Rack and pinion',
  ])
  expect(within(habitsSection).getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual([
    'Language', 'Persistence',
  ])
})

it('omits an unearned category section once every badge in that category is earned', async () => {
  const { page, service } = fixture()
  service.mockResolvedValueOnce(Response.json({
    ...empty,
    awards: [
      { ...award, id: 'h1', kind: 'language', earnedAt: '2026-11-22T10:00:00.000Z' },
      { ...award, id: 'h2', kind: 'patience', earnedAt: '2026-11-22T11:00:00.000Z' },
      { ...award, id: 'h3', kind: 'persistence', earnedAt: '2026-11-22T12:00:00.000Z' },
    ],
  }))
  render(page)
  await act(async () => {})
  expect(document.querySelector('[data-category="habits"]')).toBeNull()
  expect(document.querySelector('[data-category="mechanical"]')).toBeTruthy()
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
  expect(screen.getByRole('alert').textContent).toContain('Some projects still need a badge check.')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await act(async () => {})
  expect(service.mock.calls[3]?.[0]).toBe('/api/print-studio/badges/retry')
  expect(service.mock.calls[3]?.[1]?.method).toBe('POST')
  expect(screen.getByRole('status').textContent).toContain('Checking your latest work')
})

it('announces each new award once, keeps project focus, and advances after dismissal', async () => {
  const { stream, connect, reveal } = fixture()
  render(<><input aria-label="Project message" />{reveal}</>)
  const project = screen.getByRole('textbox', { name: 'Project message' })
  act(() => project.focus())
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('')
  expect(connect).toHaveBeenCalledExactlyOnceWith('/api/print-studio/badges/events')
  act(() => stream.earned(award, { id: 'two', kind: 'barrel-hinge' }, award))
  expect(status.textContent).toBe('You earned the Wheel and axle badge in Cart.')
  expect(screen.getByRole('complementary').parentElement).toBe(document.body)
  expect(within(screen.getByRole('complementary')).getByText('Wheel and axle')).toBeTruthy()
  expect(document.activeElement).toBe(project)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss badge reveal' }))
  expect(status.textContent).toBe('You earned the Barrel hinge badge in Cart.')
  expect(screen.queryByText('Wheel and axle')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss badge reveal' }))
  act(() => stream.earned(award))
  expect(status.textContent).toBe('')
  expect(screen.queryByRole('complementary')).toBeNull()

  act(() => { for (const dispose of disposers.splice(0).reverse()) dispose() })
  expect(stream.close).toHaveBeenCalledOnce()
  act(() => stream.earned({ id: 'late', kind: 'gear-pair' }))
  expect(status.textContent).toBe('')
})

it('presents queued awards one at a time, with artwork and name on the same rotating face', async () => {
  const { stream, reveal } = fixture()
  stream.earned({ id: 'hinge', kind: 'living-hinge' }, award)
  render(reveal)

  const first = screen.getByRole('complementary')
  const plate = first.querySelector('.rumi-badge-reveal-plate')!
  const front = plate.querySelector<HTMLElement>('.rumi-badge-face')!
  expect(within(front).getByText('Living hinge')).toBeTruthy()
  expect(within(front).getByText('Cart')).toBeTruthy()
  expect(front.querySelector<HTMLImageElement>('.rumi-badge-artwork')?.src).toContain('/living-hinge.webp')
  expect(plate.querySelector('.rumi-badge-reveal-back')?.getAttribute('aria-hidden')).toBe('true')
  expect(plate.querySelector<HTMLImageElement>('.rumi-badge-reveal-back .rumi-badge-artwork')?.src).toContain('/reverse.webp')
  expect(screen.queryByText('Wheel and axle')).toBeNull()

  await act(async () => { await vi.advanceTimersByTimeAsync(3700) })
  expect(first.hasAttribute('data-leaving')).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  const second = screen.getByRole('complementary')
  expect(first.isConnected).toBe(false)
  expect(second.hasAttribute('data-leaving')).toBe(false)
  expect(second.querySelector<HTMLImageElement>('.rumi-badge-face .rumi-badge-artwork')?.src).toContain('/wheel-and-axle.webp')
  expect(within(second).getByText('Wheel and axle')).toBeTruthy()
  fireEvent.pointerOver(second, { pointerType: 'touch' })
  await act(async () => { await vi.advanceTimersByTimeAsync(4300) })
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('')
})

it('keeps an award earned in a hidden window until the child returns to the project', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  try {
    const { stream, reveal } = fixture()
    render(reveal)
    act(() => stream.earned(award))
    await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
    expect(screen.queryByRole('complementary')).toBeNull()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    const card = screen.getByRole('complementary')
    expect(within(card).getByText('Wheel and axle')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(3700) })
    expect(card.hasAttribute('data-leaving')).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(screen.queryByRole('complementary')).toBeNull()
  } finally {
    hidden.mockRestore()
  }
})

it('keeps a reveal while it is hovered or focused and announces it in the active locale', async () => {
  const { stream, reveal } = fixture('zh')
  render(reveal)
  act(() => stream.earned(award))
  const card = screen.getByRole('complementary')
  expect(screen.getByRole('status').textContent).toBe('你在Cart项目中获得了车轮与轮轴徽章。')
  fireEvent.pointerOver(card)
  await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
  const dismiss = screen.getByRole('button', { name: '关闭徽章提示' })
  act(() => dismiss.focus())
  fireEvent.pointerOut(card)
  await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
  expect(screen.getByRole('complementary')).toBe(card)
  act(() => dismiss.blur())
  await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
  expect(screen.queryByRole('complementary')).toBeNull()
})

it('refreshes the open collection as soon as the new award arrives', async () => {
  const { page, service, stream } = fixture()
  service.mockResolvedValueOnce(Response.json(empty)).mockResolvedValueOnce(Response.json({
    ...empty, awards: [award],
  }))
  render(page)
  await act(async () => {})
  expect(service).toHaveBeenCalledTimes(1)
  await act(async () => { stream.earned(award) })
  expect(screen.getByText('1 badge earned')).toBeTruthy()
  expect(screen.getAllByRole('heading', { level: 2 })[0]?.textContent).toBe('Wheel and axle')
})
