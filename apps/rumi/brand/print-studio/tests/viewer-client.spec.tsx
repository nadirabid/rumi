/** The pane follows the host's scene: geometry loads once, placement updates reuse the viewport. */
import * as React from 'react'
import { PerspectiveCamera } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { printLayoutIdentity } from '../viewer/print-layout/state.js'
import { installViewer } from '../viewer/client.js'
import { en, zh } from '../viewer/locales.js'
import { encodeStl } from '../viewer/stl.js'

vi.mock('../viewer/viewer.module.css', () => ({ default: '' }))
const viewport = vi.hoisted(() => ({ setActivity: vi.fn(), closePrintLayout: vi.fn(), motionControls: vi.fn(), updateMotion: vi.fn(), modelParameters: vi.fn(() => ({ width: 12 })), renderedHighlight: vi.fn(), captureCursor: vi.fn(), setCursorMode: vi.fn(), setHighlightVisible: vi.fn(), apply: vi.fn(), dispose: vi.fn(), create: vi.fn(), applyDesign: vi.fn(), thumbnail: vi.fn(() => 'data:image/png;base64,cG5n') }))
vi.mock('../viewer/viewport/index.js', () => ({
  createViewport: (...args: unknown[]) => {
    viewport.create(...args)
    return {
      setActivity: viewport.setActivity, closePrintLayout: viewport.closePrintLayout,
      motionControls: viewport.motionControls, updateMotion: viewport.updateMotion,
      modelParameters: viewport.modelParameters, renderedHighlight: viewport.renderedHighlight,
      captureCursor: viewport.captureCursor, setCursorMode: viewport.setCursorMode, setHighlightVisible: viewport.setHighlightVisible,
      thumbnail: viewport.thumbnail, apply: viewport.apply, applyDesign: viewport.applyDesign, dispose: viewport.dispose,
    }
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
  viewport.motionControls.mockReset().mockReturnValue(null)
  viewport.updateMotion.mockReset().mockReturnValue(true)
  viewport.applyDesign.mockReset().mockResolvedValue(null)
  viewport.captureCursor.mockReset().mockReturnValue({ status: 'no_hit' })
  viewport.setCursorMode.mockClear()
  viewport.renderedHighlight.mockReset().mockReturnValue(null)
  viewport.closePrintLayout.mockReset()
  viewport.setActivity.mockReset()
  viewport.create.mockReset()
  viewport.apply.mockClear()
  viewport.dispose.mockReset()
  viewport.thumbnail.mockClear()
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
  let mounted: string | undefined = 'session-a'
  const mountedListeners = new Set<() => void>()
  const state = { scene: host.scene ?? null, modelOk: host.modelOk ?? true, cursorRequest: null as { id: string } | null }
  const fetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url).includes('/state')) return { ok: true, json: async () => ({ scene: state.scene, cursorRequest: state.cursorRequest }) }
    if (!state.modelOk) return { ok: false }
    return { ok: true, arrayBuffer: async () => encodeStl(positions()) }
  })
  vi.stubGlobal('fetch', fetch)
  installViewer({
    locale: { bind: () => t, register },
    effect: (effect: () => (() => void | Promise<void>)) => { const dispose = effect(); disposers.push(dispose); return dispose },
    sidebarRight: {
      mounted: {
        getSnapshot: () => mounted,
        subscribe: (listener: () => void) => { mountedListeners.add(listener); return () => mountedListeners.delete(listener) },
      },
      openTabIn: opened,
    },
    sidebarRightTabs: { register }, documentPreviews: { register },
    slots: {
      inject: (_name: string, registerEntry: () => (() => void)) => registerEntry(),
      register: (options: { name: string; inject?: Entry['inject'] }, component: Entry['component']) => {
        entries.set(options.name, { component, inject: options.inject })
        return () => { entries.delete(options.name) }
      },
    },
  }, React, { Menu, IconChevronDownOutlineRegular, PluginArtworkDefault: () => null, Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant: string; size: string }) => React.createElement('button', props) })
  return {
    opened, fetch,
    mount: (id: string | undefined) => { mounted = id; for (const listener of mountedListeners) listener() },
    requestCursor: (id: string) => { state.cursorRequest = { id } },
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

it('discovers new model controls without a geometry revision and selects the requested entry', async () => {
  const base = { ...scene([]), models: [{ name: 'helmet', path: 'models/helmet/model.js' }], selectedModel: 'models/helmet/model.js' }
  const view = fixture({ scene: base })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByRole('button', { name: 'helmet' }).getAttribute('aria-pressed')).toBe('true')
  view.setScene({ ...base, models: [...base.models, { name: 'gloves', path: 'models/gloves/model.js' }] })
  await settle(2000)
  fireEvent.click(screen.getByRole('button', { name: 'gloves' }))
  await settle()
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/select?sessionId=session-a', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ path: 'models/gloves/model.js' }),
  }))
})

it('shows a selected model without waiting for the next poll', async () => {
  const models = [{ name: 'helmet', path: 'models/helmet/model.js' }, { name: 'gloves', path: 'models/gloves/model.js' }]
  const base = { ...scene([]), models, selectedModel: models[0].path, design: { url: '/source/helmet/model.js', revision: 1 } }
  const view = fixture({ scene: base })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const next = { ...base, selectedModel: models[1].path, design: { url: '/source/gloves/model.js', revision: 2 } }
  view.setScene(next)
  fireEvent.click(screen.getByRole('button', { name: 'gloves' }))
  await settle()
  expect(screen.getByRole('button', { name: 'gloves' }).getAttribute('aria-pressed')).toBe('true')
  expect(viewport.applyDesign).toHaveBeenLastCalledWith(next.design, null)
  expect(viewport.create).toHaveBeenCalledOnce()
})

it('refreshes after an in-flight poll without leaving the previous model selected', async () => {
  const models = [{ name: 'helmet', path: 'models/helmet/model.js' }, { name: 'gloves', path: 'models/gloves/model.js' }]
  const base = { ...scene([]), models, selectedModel: models[0].path }
  const view = fixture({ scene: base })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const poll = Promise.withResolvers<Awaited<ReturnType<typeof view.fetch>>>()
  view.fetch.mockImplementationOnce(() => poll.promise)
  await settle(2000)
  view.setScene({ ...base, selectedModel: models[1].path })
  fireEvent.click(screen.getByRole('button', { name: 'gloves' }))
  await settle()
  expect(screen.getByRole('button', { name: 'gloves' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { poll.resolve({ ok: true, json: async () => ({ scene: base }) }) })
  await settle()
  expect(screen.getByRole('button', { name: 'gloves' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'gloves' }).hasAttribute('disabled')).toBe(false)
  view.setScene(base)
  await settle(2000)
  expect(screen.getByRole('button', { name: 'helmet' }).getAttribute('aria-pressed')).toBe('true')
})

it('keeps model controls usable and reports a selection failure', async () => {
  const view = fixture({ modelOk: false, scene: { ...scene([]), models: [{ name: 'helmet', path: 'models/helmet/model.js' }] } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'helmet' }))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe(en.selectionFailed)
  expect(screen.getByRole('button', { name: 'helmet' }).hasAttribute('disabled')).toBe(false)
})

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

it('draws the scene and opens the tab without a geometry warning badge', async () => {
  const view = fixture({ scene: scene([object({ blocked: true })], { status: 'blocked', errors: 1, warnings: 0 }) })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.getByTestId('print-viewport')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
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


it('captures once after a scene settles and does not recapture unchanged polling', async () => {
  const view = fixture({ scene: scene([object()]) })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  await settle(800)
  expect(viewport.thumbnail).toHaveBeenCalledTimes(1)
  expect(view.fetch.mock.calls.some(([url]) => String(url).includes('/rumi-projects/thumbnail?sessionId=session-a'))).toBe(true)
  await settle(4000)
  expect(viewport.thumbnail).toHaveBeenCalledTimes(1)
})

it('captures only on an agent request without rebuilding an unchanged scene', async () => {
  const view = fixture({ scene: scene([object()]) })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(viewport.captureCursor).not.toHaveBeenCalled()
  const applications = viewport.apply.mock.calls.length
  view.requestCursor('cursor-request')
  await settle(2000)
  expect(viewport.captureCursor).toHaveBeenCalledOnce()
  expect(viewport.apply).toHaveBeenCalledTimes(applications)
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/cursor?sessionId=session-a', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ requestId: 'cursor-request', snapshot: { status: 'no_hit' } }),
  }))
  cleanup()
  view.requestCursor('closed-request')
  await settle(2000)
  expect(viewport.captureCursor).toHaveBeenCalledOnce()
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/cursor?sessionId=session-a', expect.objectContaining({
    body: JSON.stringify({ requestId: 'closed-request', snapshot: { status: 'viewer_unavailable', reason: 'viewer_not_open' } }),
  }))
})

it('acknowledges a highlight when the document becomes visible without another scene change', async () => {
  const design = { url: '/source/one/model.js', revision: 1, transform: { scale: 1 }, highlight: { id: 'region-one', meshPath: 'overlay.stl' } }
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  viewport.applyDesign.mockResolvedValue({ status: 'ok', dimensions: { x: 10, y: 20, z: 30 }, checks: [] })
  viewport.renderedHighlight.mockImplementation(() => document.hidden ? null : 'region-one')
  try {
    const view = fixture({ scene: { ...scene([]), design } })
    render(view.view('sidebar.right.pane.tab'))
    await settle()
    view.fetch.mockClear()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    await settle()
    expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/feedback?sessionId=session-a', expect.objectContaining({
      body: expect.stringContaining('"highlightId":"region-one"'),
    }))
  } finally { hidden.mockRestore() }
})

it('reports the rendered identity and client timing for a visible highlight', async () => {
  const design = { url: '/source/one/model.js', revision: 1, transform: { scale: 1 }, highlight: { id: 'region-visible', meshPath: 'overlay.stl' } }
  viewport.applyDesign.mockResolvedValue({ status: 'ok', dimensions: { x: 10, y: 20, z: 30 }, checks: [] })
  viewport.renderedHighlight.mockReturnValue('region-visible')
  const view = fixture({ scene: { ...scene([]), design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/feedback?sessionId=session-a', expect.objectContaining({
    body: expect.stringContaining('"highlightId":"region-visible"'),
  }))
  expect(viewport.applyDesign).toHaveBeenCalledWith({ ...design, highlight: { ...design.highlight, positions: positions() } }, null)
  const delivered = view.fetch.mock.calls.find(([url]) => String(url).includes('/feedback?'))!
  expect(JSON.parse(String(delivered[1]?.body))).toMatchObject({
    revision: 1, url: design.url, transform: design.transform, volume: null,
    loadStatus: 'ready', parameters: { width: 12 },
  })
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/trace?sessionId=session-a', expect.objectContaining({
    body: expect.stringContaining('"phase":"apply_finished"'),
  }))
})

it('reports viewport initialization failure for the requested model instead of waiting for timeout', async () => {
  viewport.create.mockImplementationOnce(() => { throw new Error('WebGL unavailable') })
  const design = { url: '/source/failed/model.js', revision: 3, transform: { scale: 1 } }
  const view = fixture({ scene: { ...scene([]), design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const delivered = view.fetch.mock.calls.filter(([url]) => String(url).includes('/feedback?'))
  expect(delivered.length).toBeGreaterThan(0)
  expect(JSON.parse(String(delivered.at(-1)![1]?.body))).toMatchObject({
    revision: 3, url: design.url, volume: null, loadStatus: 'build_failed', error: 'WebGL unavailable',
  })
})

it('shows only a discreet error dot, retaining unresolved findings until a fresh pass', async () => {
  const base = scene([object()])
  const view = fixture({ scene: { ...base, validation: { error: null, models: [{ status: 'checking' }] } } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(screen.queryByLabelText(en.validationRepair)).toBeNull()
  for (const model of [{ status: 'needs_repair' }, { status: 'checking', previousReport: { status: 'needs_repair' } }]) {
    view.setScene({ ...base, validation: { error: null, models: [model] } })
    await settle(2000)
    expect(screen.getByLabelText(en.validationRepair).className).toBe('pv-validation-dot')
    expect(screen.queryByText(en.validationRepair)).toBeNull()
  }
  view.setScene({ ...base, validation: { error: null, models: [{ status: 'passed', report: { status: 'passed' } }] } })
  await settle(2000)
  expect(screen.queryByLabelText(en.validationRepair)).toBeNull()
  view.setScene({ ...base, validation: { error: null, models: [{ status: 'unavailable' }] } })
  await settle(2000)
  expect(screen.getByLabelText(en.validationUnavailable)).toBeTruthy()
  view.setScene({ ...base, validation: { error: null, models: [{ status: 'review', report: { status: 'review', mechanics: { status: 'review' } } }] } })
  await settle(2000)
  expect(screen.getByLabelText(en.validationMechanicsReview).className).toBe('pv-validation-dot')
  expect(screen.queryByText(en.validationMechanicsReview)).toBeNull()
})

it('keeps movement controls in their own area across model reloads without opening an edit', async () => {
  const controls = [{ kind: 'slider', label: 'Doors', axes: [{ key: 'doorAngle', min: 0, max: 100, step: 1, reset: 0 }] }]
  const motion = { id: 'first', values: { doorAngle: 0 }, controls }
  viewport.motionControls.mockReturnValue(motion)
  viewport.applyDesign.mockResolvedValue({ status: 'review', dimensions: { x: 20, y: 20, z: 20 }, checks: [] })
  const design = { path: 'models/car/model.js', url: '/first.js', revision: 1, transform: {} }
  const view = fixture({ scene: { ...scene([]), design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const slider = screen.getByRole('slider', { name: 'Doors' })
  expect(slider.closest('.pv-motion-controls')).toBeTruthy()
  expect(slider.closest('.pv-bottom-controls')).toBeTruthy()
  fireEvent.input(slider, { target: { value: '58' } })
  expect(viewport.updateMotion).toHaveBeenCalledWith({ doorAngle: 58 })
  viewport.motionControls.mockReturnValue({ ...motion, id: 'second', values: { doorAngle: 58 } })
  view.setScene({ ...scene([]), design: { ...design, url: '/second.js', revision: 2 } })
  await settle(2000)
  expect(screen.getByRole('slider', { name: 'Doors' }).getAttribute('value')).toBe('58')
  expect(view.fetch.mock.calls.some(([url]) => String(url).includes('/shape-feedback'))).toBe(false)
  view.setScene({ ...scene([]), design: { ...design, url: '/second.js', revision: 2, analog: {
    id: 'width-edit', operation: 'parameters', label: 'Size', values: { width: 20 },
    controls: [{ kind: 'slider', label: 'Width', axes: [{ key: 'width', min: 10, max: 40, step: 1, reset: 20 }] }],
  } } })
  await settle(2000)
  expect(screen.getByRole('slider', { name: 'Doors' }).closest('fieldset')?.disabled).toBe(true)
  expect(screen.getByRole('slider', { name: 'Width' }).closest('.pv-motion-controls')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.cursor_part }))
  expect(viewport.setCursorMode).toHaveBeenCalledWith('part')
  viewport.motionControls.mockReturnValue(null)
  view.setScene({ ...scene([]), design: { ...design, url: '/without-movement.js', revision: 3 } })
  await settle(2000)
  expect(screen.queryByRole('slider', { name: 'Doors' })).toBeNull()
})


it.each([
  ['changed', 'validationChanged'], ['checking', 'validationChecking'], ['needs_repair', 'validationRepair'],
  ['review', 'validationReview'], ['unavailable', 'validationUnavailable'], ['passed', 'layoutModelChecked'],
  ['checked', 'validationChecksPassed'],
] as const)('shows the selected model’s %s status while arranging for print', async (status, label) => {
  const path = 'models/kart/model.usda'
  const model = { path, status: status === 'checked' ? 'review' : status, sourceHash: 'current', fingerprint: 'revision',
    acceptedFingerprint: status === 'checked' ? null : 'revision',
    ...(status === 'checked' ? { report: { checks: [], mechanics: { status: 'passed', assemblyVerified: true, coverage: { complete: true } } } } : {}) }
  const base = { ...scene([]), selectedModel: path, design: { url: '/kart/model.usda', contentHash: 'current', revision: 1 },
    validation: { models: [{ ...model, path: 'models/other/model.usda', status: 'needs_repair' }, model] } }
  const view = fixture({ scene: base })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const publish = viewport.create.mock.calls.at(-1)?.[4]
  expect(typeof publish).toBe('function')
  act(() => publish({ active: true, selected: 'body', plate: 0, parts: [{ id: 'body', name: 'Body' }], issues: [],
    layout: { identity: 'kart', parts: [{ id: 'body', plate: 0 }], volume: { x: 300, y: 320, z: 320 }, gap: 5 } }))
  expect(status === 'checking' ? screen.getByRole('img', { name: en.activityChecking }) : screen.getByRole('img', { name: en[label] })).toBeTruthy()
  view.setScene({ ...base, design: { ...base.design, contentHash: 'new' } })
  await settle(2000)
  expect(status === 'checking' ? screen.getByRole('img', { name: en.activityChecking }) : screen.getByRole('img', { name: en[status === 'unavailable' ? 'validationUnavailable' : 'validationChanged'] })).toBeTruthy()
})


it('autosaves committed placement, deduplicates selection, and exposes retry after failure', async () => {
  const design = { path: 'models/kart/model.usda', url: '/kart/model.usda', contentHash: 'current', revision: 1 }
  const volume = { x: 300, y: 320, z: 320 }
  const view = fixture({ scene: { ...scene([]), volume, design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const publish = viewport.create.mock.calls.at(-1)?.[4]
  const layout = { identity: printLayoutIdentity(design, volume), parts: [{ id: 'body', plate: 0, position: [0, 0] }], volume, gap: 5 }
  const state = { active: true, selected: 'body', plate: 0, parts: [{ id: 'body', name: 'Body' }], issues: [], layout }
  act(() => publish(state))
  await settle()
  const saves = () => view.fetch.mock.calls.filter(([url, init]) => String(url).includes('/layout?') && init?.method === 'POST')
  expect(saves()).toHaveLength(1)
  act(() => publish({ ...state, selected: null }))
  await settle()
  expect(saves()).toHaveLength(1)
  const pending = Promise.withResolvers<never>()
  view.fetch.mockImplementationOnce(() => pending.promise)
  try {
    act(() => publish({ ...state, layout: { ...layout, gap: 6 } }))
    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.layoutBackToModel }))
    expect(viewport.closePrintLayout).not.toHaveBeenCalled()
    pending.reject(new Error('offline'))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain(en.layoutSaveFailed)
    expect(viewport.closePrintLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.layoutRetrySave }))
    await settle()
    expect(screen.queryByText(en.layoutSaveFailed)).toBeNull()
    expect(JSON.parse(String(saves().at(-1)?.[1]?.body)).gap).toBe(6)
    fireEvent.click(screen.getByRole('button', { name: en.layoutBackToModel }))
    await settle()
    expect(viewport.closePrintLayout).toHaveBeenCalledOnce()
  } finally { pending.reject(new Error('test cleanup')); await settle() }
})


it('animates work without visible labels and locks print actions while retaining precise pointing', async () => {
  const path = 'models/kart/model.usda'
  const base = { ...scene([]), selectedModel: path, design: { url: '/kart/model.usda', contentHash: 'current', revision: 1 },
    workingModels: [path], agentRunning: true }
  const view = fixture({ scene: base })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  expect(viewport.setActivity).toHaveBeenLastCalledWith('building')
  expect(screen.getByRole('button', { name: en.layoutPrint }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.cursor_patch }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText(en.activityBuilding)).toBeNull()
  view.setScene({ ...base, validation: { models: [{ path, status: 'checking' }] } })
  await settle(2000)
  expect(viewport.setActivity).toHaveBeenLastCalledWith('checking')
  view.setScene({ ...base, validation: { models: [{ path, status: 'valid' }] } })
  await settle(2000)
  expect(viewport.setActivity).toHaveBeenLastCalledWith('building')
  expect(screen.getByRole('button', { name: en.layoutPrint }).hasAttribute('disabled')).toBe(true)
  view.setScene({ ...base, agentRunning: false, workingModels: [] })
  await settle(2000)
  expect(viewport.setActivity).toHaveBeenLastCalledWith('idle')
  expect(screen.getByRole('button', { name: en.layoutPrint }).hasAttribute('disabled')).toBe(false)
})


it('disconnects real orbit controls from the document before detaching each viewer', async () => {
  const registered = vi.spyOn(document, 'addEventListener')
  const removed = vi.spyOn(document, 'removeEventListener')
  const controls: OrbitControls[] = []
  viewport.create.mockImplementation((holder: HTMLElement) => {
    const canvas = document.createElement('canvas')
    holder.appendChild(canvas)
    const control = new OrbitControls(new PerspectiveCamera(), canvas)
    controls.push(control)
    viewport.dispose.mockImplementation(() => { expect(canvas.isConnected).toBe(true); control.dispose(); canvas.remove() })
  })
  const view = fixture({ scene: scene([object()]) })
  try {
    for (let index = 0; index < 3; index++) {
      const rendered = render(view.view('sidebar.right.pane.tab'))
      await settle()
      rendered.unmount()
    }
    const handlers = registered.mock.calls.filter(([type, , options]) => type === 'keydown' && typeof options === 'object' && options.capture)
    expect(handlers).toHaveLength(3)
    for (const [, handler] of handlers) {
      expect(removed).toHaveBeenCalledWith('keydown', handler, { capture: true })
    }
  } finally {
    for (const [type, handler, options] of registered.mock.calls) {
      if (type === 'keydown' && typeof options === 'object' && options.capture) document.removeEventListener(type, handler, options)
    }
    for (const control of controls) control.dispose()
    registered.mockRestore(); removed.mockRestore()
  }
})

it('reads a newly mounted project immediately and stops polling in the gallery', async () => {
  const view = fixture()
  await settle()
  view.mount(undefined)
  await settle()
  view.fetch.mockClear()
  await settle(6000)
  expect(view.fetch).not.toHaveBeenCalled()
  view.mount('session-b')
  await settle()
  expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/state?sessionId=session-b', expect.anything())
})


it('pauses scene polls while hidden and refreshes immediately on return', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  try {
    const view = fixture()
    await settle()
    hidden.mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    await settle()
    view.fetch.mockClear()
    await settle(6000)
    expect(view.fetch).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    await settle()
    expect(view.fetch).toHaveBeenCalledWith('/api/print-studio/viewer/state?sessionId=session-a', expect.anything())
  } finally { hidden.mockRestore() }
})


it('acknowledges an explicit reload without a new source URL', async () => {
  const design = { url: '/source/one/model.usda', revision: 1, transform: { scale: 1 } }
  viewport.applyDesign.mockResolvedValue({ status: 'ok', dimensions: { x: 1, y: 1, z: 1 }, checks: [] })
  const view = fixture({ scene: { ...scene([]), design } })
  render(view.view('sidebar.right.pane.tab'))
  await settle()
  const applications = viewport.applyDesign.mock.calls.length
  view.setScene({ ...scene([]), design: { ...design, renderRequest: 'reload-request' } })
  await settle(2000)
  expect(viewport.applyDesign.mock.calls.length).toBeGreaterThan(applications)
  const feedback = view.fetch.mock.calls.filter(([url]) => String(url).includes('/feedback?')).map(([, init]) => JSON.parse(String(init?.body)))
  expect(feedback.at(-1)).toMatchObject({ url: design.url, revision: 1, renderRequest: 'reload-request', loadStatus: 'ready' })
})
