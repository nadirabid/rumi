// @vitest-environment jsdom
/** Exercise the bundled composer with the same directory contract used by /model. */
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JSX from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

beforeAll(() => execFileSync(process.execPath, ['apps/rumi/brand/model-picker/build.mjs']))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(provider = 'rumi-chatgpt') {
  const model = { id: 'gpt-6.2-sol', name: 'Sol', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }
  const directory = createSnapshotStore({ status: 'ready', current: { provider, model: model.id, reasoningEffort: 'high' },
    pending: null, groups: [{ id: provider, name: 'Provider', models: [model] }], failures: [] })
  const select = vi.fn()
  const load = vi.fn(async () => directory.getSnapshot())
  const calls: { sessionId: string; model: string; tier: string }[] = []
  let requested = 'ultrafast'
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    if (options.method === 'POST') {
      const choice = JSON.parse(String(options.body))
      calls.push(choice)
      requested = choice.tier
    }
    return Response.json({ requested, tiers: ['auto', 'priority', 'ultrafast'] })
  })
  type PickerProps = {
    locked: boolean
    sessionId: string
    available: boolean
    directory: typeof directory
    load: typeof load
    select: typeof select
    t: (key: string) => string
    renderSlot: (_name: string, _owner: object, opts: { fallback: string }) => string
  }
  let Picker: React.ComponentType<PickerProps>
  let props: PickerProps
  let copy: Record<string, string>
  const ctx = { effect() {},
    locale: { register() {} },
    modelDirectories: { directoryFor: () => ({ store: directory, select, load }) }, sessions: { subagentAddress: () => undefined },
    slots: {
      inject: (key: string, register: () => void) => { if (key === 'conversation.input.model') register() },
      register: (_spec: { inject: (id: string) => PickerProps }, component: typeof Picker) => {
        Picker = component
        props = _spec.inject('conversation-a')
      },
    },
  }
  const modules: Record<string, object> = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': JSX,
    '@deepseek-ai/dsh-client-ui-primitives': ui }
  const source = readFileSync('apps/rumi/brand/model-picker/lib/client.js', 'utf8')
  new Function('window', source)({ addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window), innerWidth: 900, innerHeight: 700,
    __ModuleLoader__: { load(entry: { factory: (get: (id: string) => object) => {
      apply: (context: object) => void } }) {
      const plugin = entry.factory(id => modules[id]!)
      plugin.apply({ ...ctx, effect: (setup: () => void) => setup(),
        locale: { register: (_ns: string, value: { en: Record<string, string> }) => { copy = value.en } } })
    } } })
  const view = () => render(<Picker {...props} locked={false} t={key => copy[key] ?? key}
    renderSlot={(_key, _owner, opts) => opts.fallback} />)
  return { view, select, calls }
}

it('loads account speeds and changes only the requested tier for the open conversation', async () => {
  const f = fixture()
  f.view()
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Requested speed.*Ultrafast/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fast' }))
  await screen.findByRole('button', { expanded: false })
  expect(f.select).not.toHaveBeenCalled()
  expect(f.calls).toEqual([{ sessionId: 'conversation-a', model: 'gpt-6.2-sol', tier: 'priority' }])
  cleanup()
  f.view()
  fireEvent.click(screen.getByRole('button'))
  expect(await screen.findByRole('menuitem', { name: /Requested speed.*Fast/ })).toBeTruthy()
})

it('keeps the model and effort controls for other providers', async () => {
  fixture('baseten').view()
  fireEvent.click(screen.getByRole('button'))
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  expect(screen.queryByText('Requested speed')).toBeNull()
})
