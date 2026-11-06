// @vitest-environment jsdom
/** Control receipts recover on visibility and distinguish render failures from delivery failures. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { installViewer } from '../brand/print-studio/viewer/client.js'

type Snapshot = { scene: unknown; view: unknown }
type SceneHook = { subscribe: (listener: () => void) => () => void; getSnapshot: () => Snapshot }
type Injection = { hooks: { scene: SceneHook }; selectModel: (path: string, signal: AbortSignal) => Promise<void> }
type PaneProps = { useScene: <T>(selector: (state: Snapshot) => T) => T; t: (key: string) => string; selectModel: Injection['selectModel'] }
type PaneRegistration = { name: string; inject: (session: string) => Injection }

const renderer = vi.hoisted(() => ({ fail: false }))
vi.mock('../brand/print-studio/viewer/viewer.module.css', () => ({ default: '' }))
vi.mock('../brand/print-studio/viewer/viewport/index.js', () => ({
  createViewport: () => ({
    apply() {}, dispose() {}, shapeMetrics: () => ({}),
    applyDesign: async () => ({ status: 'ok' }),
    applyShape: (spec: { id: string } | null) => {
      if (renderer.fail && spec) throw new Error('Controls must bind declared model parameters')
      return spec?.id ?? null
    },
  }),
}))

it.each(['hidden', 'render error', 'delivery error'])('reports and recovers from %s without reopening controls', async (failure) => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  let hidden = failure === 'hidden', deliveryFailed = failure === 'delivery error'
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  renderer.fail = failure === 'render error'
  const posts: { status: string; error?: string }[] = []
  const container = document.createElement('div'), root = createRoot(container)
  const cleanup: (() => void | Promise<void>)[] = []
  let Pane: React.ComponentType<PaneProps> | undefined, definition: PaneRegistration | undefined
  const scene = { revision: 1, objects: [], models: [], workingModels: [], volume: null, design: {
    url: '/model.mjs', revision: 1, transform: {}, analog: { id: 'edit', operation: 'parameters', label: 'Size', values: { size: 60 },
      controls: [{ kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] }],
    },
  } }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url.includes('/state?')) return { ok: true, json: async () => ({ scene }) }
    if (url.includes('/events?')) return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    if (url.includes('/shape-feedback?')) {
      if (typeof options.body !== 'string') throw new Error('Expected serialized feedback')
      const body = JSON.parse(options.body) as { status: string; error?: string }; posts.push(body)
      return { ok: !deliveryFailed }
    }
    return { ok: true, json: async () => ({}) }
  }))
  try {
    await act(async () => {
      installViewer({
        effect: (fn: () => (() => void) | undefined) => { const dispose = fn(); if (dispose) cleanup.push(dispose) },
        locale: { bind: () => (key: string) => key, register: () => () => {} },
        sidebarRight: { mounted: { getSnapshot: () => 'test' }, openTabIn() {} },
        sidebarRightTabs: { register: () => () => {} }, documentPreviews: { register: () => () => {} },
        slots: { inject: (_key: string, fn: () => void) => { fn() },
          register: (spec: PaneRegistration, component: React.ComponentType<PaneProps>) => {
            if (spec.name === 'sidebar.right.pane.tab') { definition = spec; Pane = component }
            return () => {}
          } },
      }, React, { Button: 'button', PluginArtworkDefault: () => null })
      if (!definition || !Pane) throw new Error('Viewer pane was not registered')
      const injected = definition.inject('test')
      const useScene = <T>(selector: (value: Snapshot) => T) => selector(
        React.useSyncExternalStore(injected.hooks.scene.subscribe, injected.hooks.scene.getSnapshot),
      )
      root.render(React.createElement(Pane, { useScene, t: (key: string) => key, selectModel: injected.selectModel }))
    })
    expect(posts.map(post => post.status)).toEqual([failure === 'hidden' ? 'viewer_hidden' : failure === 'render error' ? 'render_failed' : 'rendered'])
    if (failure === 'render error') expect(posts[0].error).toBe('Controls must bind declared model parameters')
    hidden = false; renderer.fail = false; deliveryFailed = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(posts.at(-1)?.status).toBe('rendered')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { root.unmount() })
    const count = posts.length
    document.dispatchEvent(new Event('visibilitychange'))
    expect(posts).toHaveLength(count)
  } finally {
    await act(async () => { root.unmount() })
    for (const dispose of cleanup.reverse()) await dispose()
    if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
    else Reflect.deleteProperty(document, 'hidden')
    renderer.fail = false; vi.unstubAllGlobals(); vi.useRealTimers()
  }
})
