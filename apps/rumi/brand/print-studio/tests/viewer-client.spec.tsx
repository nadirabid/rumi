/** The pane follows the host's scene: geometry loads once, placement updates reuse the viewport. */
import * as React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { installViewer } from '../viewer/client.js'
import { en, zh } from '../viewer/locales.js'
import { encodeStl } from '../viewer/stl.js'

vi.mock('../viewer/viewer.module.css', () => ({ default: '' }))
const viewport = vi.hoisted(() => ({ apply: vi.fn(), dispose: vi.fn(), create: vi.fn(), applyDesign: vi.fn() }))
vi.mock('../viewer/viewport/index.js', () => ({
  createViewport: (...args: unknown[]) => {
    viewport.create(...args)
    return { apply: viewport.apply, applyDesign: viewport.applyDesign, dispose: viewport.dispose }
  },
}))

type Hooks = Record<string, HostObservable<unknown>>
type Entry = {
  component: React.ComponentType<Record<string, unknown>>
  inject?: (sessionId: string) => { hooks?: Hooks }
}
const disposers: (() => void | Promise<void>)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  viewport.applyDesign.mockReset().mockResolvedValue(null)
  viewport.create.mockClear()
  viewport.apply.mockClear()
  viewport.dispose.mockClear()
})
afterEach(async () => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function translate(key: string, params?: Record<string, unknown>, locale: 'en' | 'zh' = 'en') {
  const dictionary = locale === 'en' ? en : zh
  const template = dictionary[key as keyof typeof en] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const positions = () => new Float32Array([0, 0, 0, 12, 0, 0, 0, 12, 0])
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -6, -6, 0, 1]

function object(overrides: Record<string, unknown> = {}) {
  return { id: 'o1', datablockId: 'd1', name: 'box.stl', visible: true, matrix: identity, blocked: false, ...overrides }
}

function scene(objects: object[], summary = { status: 'ok', errors: 0, warnings: 0 }, revision = 1) {
  return { revision, volume: null, objects, summary }
}

/**
 * @param {{scene?: object | null, modelOk?: boolean}} [host] - What the preview routes answer.
 */
function fixture(host: { scene?: object | null; modelOk?: boolean; locale?: 'en' | 'zh' } = {}) {
  const t = (key: string, params?: Record<string, unknown>) => translate(key, params, host.locale)
  const entries = new Map<string, Entry>()
  const register = () => () => {}
  const opened = vi.fn()
  const state = { scene: host.scene ?? null, modelOk: host.modelOk ?? true }
  const fetch = vi.fn(async (url: string | URL) => {
    if (String(url).includes('/state')) return { ok: true, json: async () => ({ scene: state.scene }) }
    if (!state.modelOk) return { ok: false }
    return { ok: true, arrayBuffer: async () => encodeStl(positions()) }
  })
  vi.stubGlobal('fetch', fetch)
  installViewer({
    locale: { bind: () => t, register },
    effect: (effect: () => (() => void | Promise<void>)) => { const dispose = effect(); disposers.push(dispose); return dispose },
    sidebarRight: { mounted: { getSnapshot: () => 'session-a' }, openTabIn: opened },
    sidebarRightTabs: { register }, documentPreviews: { register },
    slots: {
      inject: (_name: string, registerEntry: () => (() => void)) => registerEntry(),
      register: (options: { name: string; inject?: Entry['inject'] }, component: Entry['component']) => {
        entries.set(options.name, { component, inject: options.inject })
        return () => { entries.delete(options.name) }
      },
    },
  }, React, { PluginArtworkDefault: () => null })
  return {
    opened, fetch,
    setScene: (next: object | null) => { state.scene = next },
    view: (name: string, owner: Record<string, unknown> = {}) => {
      const entry = entries.get(name)!
      const { hooks, ...injected } = entry.inject?.('session-a') ?? {}
      const bound = Object.fromEntries(Object.entries(hooks ?? {}).map(([hook, source]) => {
        const use = ((selector: (value: unknown) => unknown) =>
          selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot))) satisfies SnapshotSelectorHook<unknown>
        return [`use${hook[0]!.toUpperCase()}${hook.slice(1)}`, use]
      }))
      return React.createElement(entry.component, { ...owner, ...injected, ...bound, t })
    },
  }
}

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

it('invites the reader to ask for a model instead of offering controls', async () => {
  const view = fixture()
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByText(en.empty)).toBeTruthy()
  expect(screen.getByText(en.emptyHint)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByTestId('print-viewport')).toBeNull()
  expect(view.opened).not.toHaveBeenCalled()
})

it('draws the scene, opens the tab, and counts what needs fixing', async () => {
  const view = fixture({ scene: scene([object({ blocked: true })], { status: 'blocked', errors: 1, warnings: 0 }) })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByTestId('print-viewport')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(translate('needsFix', { count: 1 }))
  expect(view.opened).toHaveBeenCalledWith('session-a', 'print-studio')
  expect(viewport.apply).toHaveBeenCalledOnce()
  expect(viewport.apply.mock.calls[0][0].objects[0].positions).toHaveLength(9)
})

it('follows a placement command without refetching geometry or recreating the viewport', async () => {
  const view = fixture({ scene: scene([object()]) })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(viewport.create).toHaveBeenCalledOnce()
  const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 24, 0, 0, 1]
  view.setScene(scene([object({ matrix: moved })], { status: 'ok', errors: 0, warnings: 0 }, 2))
  await settle(2000)
  expect(viewport.create).toHaveBeenCalledOnce()
  expect(viewport.apply).toHaveBeenCalledTimes(2)
  expect(viewport.apply.mock.calls[1][0].objects[0].matrix).toEqual(moved)
  expect(view.fetch.mock.calls.filter(([url]) => String(url).includes('/model'))).toHaveLength(1)
})

it('explains a scene whose geometry could not be fetched', async () => {
  const view = fixture({ scene: scene([object()]), modelOk: false })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe(en.previewFailed)
})

it('renders an STL opened from a conversation and explains one it cannot read', () => {
  const view = fixture()
  const resourceAddress = 'dsh-resource://file/session/s/box.stl'
  const ascii = new TextEncoder().encode('solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 12 0 0\nvertex 0 12 0\nendloop\nendfacet\nendsolid model\n')
  const mounted = render(view.view('sidebar.right.tab.document', { content: { kind: 'bytes', data: ascii }, resourceAddress }))
  expect(screen.getByTestId('print-viewport')).toBeTruthy()
  expect(viewport.apply.mock.calls.at(-1)![0].objects[0].matrix).toHaveLength(16)
  mounted.rerender(view.view('sidebar.right.tab.document', { content: { kind: 'bytes', data: new TextEncoder().encode('not a mesh') }, resourceAddress }))
  expect(screen.getByRole('alert').textContent).toBe(en.failed)
})


it('keeps the viewport mounted through source build errors and reports recovery', async () => {
  const design = { url: '/source/one/model.js', revision: 1, transform: { scale: 1 } }
  viewport.applyDesign.mockResolvedValue({ dimensions: { x: 10, y: 20, z: 30 }, checks: [] })
  const view = fixture({ scene: { ...scene([]), design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByTestId('print-viewport')).toBeTruthy()
  expect(viewport.applyDesign.mock.calls[0][0]).toEqual(design)
  viewport.applyDesign.mockRejectedValueOnce(new Error('missing part'))
  view.setScene({ ...scene([]), design: { ...design, url: '/source/two/model.js', revision: 2 } })
  await settle(2000)
  expect(screen.getByRole('alert').textContent).toBe(en.buildFailed)
  expect(viewport.create).toHaveBeenCalledOnce()
  expect(view.fetch.mock.calls.some(([url]) => String(url).includes('/feedback'))).toBe(true)
  view.setScene({ ...scene([]), design: { ...design, url: '/source/three/model.js', revision: 3 } })
  await settle(2000)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(viewport.create).toHaveBeenCalledOnce()
})


it.each(['en', 'zh'] as const)('localizes persistent model failure in %s', async (locale) => {
  viewport.applyDesign.mockRejectedValueOnce(new Error('technical detail'))
  const view = fixture({ locale, scene: { ...scene([]), design: { url: '/source/broken/model.js', revision: 1 } } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe((locale === 'en' ? en : zh).buildFailed)
  expect(screen.queryByText('technical detail')).toBeNull()
})


it('reports a non-Error thrown by model code without losing the preview', async () => {
  viewport.applyDesign.mockRejectedValueOnce(null)
  const view = fixture({ scene: { ...scene([]), design: { url: '/source/non-error/model.js', revision: 1 } } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe(en.buildFailed)
  expect(screen.getByTestId('print-viewport')).toBeTruthy()
})
