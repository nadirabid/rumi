// @vitest-environment jsdom
/** Exercise the speed bundle through the stock model menu's extension seats. */
import * as React from 'react'
import * as JSX from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect } from '../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx'
import { en } from '../../../packages/client/ui-model-selection/src/client/locales.ts'

beforeAll(() => execFileSync(process.execPath, ['apps/rumi/brand/model-picker/build.mjs']))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(provider = 'rumi-chatgpt') {
  const model = { id: 'gpt-6.2-sol', name: 'Sol', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }
  const directory = createSnapshotStore<ModelDirectoryState>({
    status: 'ready', current: { provider, model: model.id, reasoningEffort: 'high' }, routable: true,
    pending: null, error: null, groups: [{ id: provider, name: 'Provider', models: [model] }], failures: [],
  })
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
  type Registration = {
    name: string
    id?: string
    key?: string
    inject: (sessionId: string) => { hooks: { modelDirectory: typeof directory } }
  }
  const seats = new Map<string, { registration: Registration; Component: React.ComponentType<Record<string, unknown>> }>()
  const modules: Record<string, object> = { react: React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-ui-primitives': ui }
  const disposers: (() => void)[] = []
  let copy: Record<string, string>
  const source = readFileSync('apps/rumi/brand/model-picker/lib/client.js', 'utf8')
  new Function('window', source)({ __ModuleLoader__: {
    load(entry: { factory: (get: (id: string) => object) => { inject: readonly string[]; apply: (context: object) => void } }) {
      const plugin = entry.factory(id => modules[id]!)
      expect(plugin.inject).toEqual(['slots', 'locale'])
      const ctx = {
        locale: { register: (_namespace: string, dictionaries: { en: Record<string, string> }) => { copy = dictionaries.en } },
        effect: (setup: () => void | (() => void)) => {
          const dispose = setup()
          if (dispose) disposers.push(dispose)
        },
        modelDirectories: { directoryFor: () => ({ store: directory, select, load }) },
        slots: {
          inject: (_name: string, register: () => void) => register(),
          register: (registration: Registration, Component: React.ComponentType<Record<string, unknown>>) => {
            seats.set(registration.name, { registration, Component })
          },
        },
        inject: (services: string[], setup: (scope: object) => void) => {
          expect(services).toEqual(['modelDirectories'])
          setup(ctx)
        },
      }
      plugin.apply(ctx)
    },
  } })
  const renderSlot: React.ComponentProps<typeof ModelSelect>['renderSlot'] = (name, owner, options) => {
    const seat = seats.get(name)
    if (!seat) return options?.fallback
    if (seat.registration.key !== undefined) expect(options?.entryKey).toBe(seat.registration.key)
    const sessionId = 'conversation-a'
    const store = seat.registration.inject(sessionId).hooks.modelDirectory
    const useModelDirectory = <Value,>(selector: (state: ModelDirectoryState) => Value) =>
      React.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
    return <seat.Component {...owner} sessionId={sessionId} useModelDirectory={useModelDirectory} t={(key: string) => copy[key]} />
  }
  const view = () => render(<ModelSelect locked={false} available directory={directory} load={load} select={select}
    resolveText={value => typeof value === 'string' ? value : value.en} t={key => en[key]} renderSlot={renderSlot} />)
  return { view, select, calls, dispose: () => disposers.forEach(dispose => dispose()) }
}

it('loads account speeds and changes only the requested tier for the open conversation', async () => {
  const f = fixture()
  try {
    f.view()
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Requested speed.*Ultrafast/ }))
    const pane = screen.getByRole('group', { name: 'Requested speed' })
    fireEvent.click(await within(pane).findByRole('menuitemradio', { name: 'Fast' }))
    await screen.findByRole('button', { expanded: false })
    expect(f.select).not.toHaveBeenCalled()
    expect(f.calls).toEqual([{ sessionId: 'conversation-a', model: 'gpt-6.2-sol', tier: 'priority' }])
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByRole('menuitem', { name: /Requested speed.*Fast/ })).toBeTruthy()
  } finally {
    f.dispose()
  }
})

it('keeps the model and effort controls for other providers', () => {
  const f = fixture('baseten')
  try {
    f.view()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    expect(screen.queryByText('Requested speed')).toBeNull()
  } finally {
    f.dispose()
  }
})
