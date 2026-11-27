// @vitest-environment jsdom
/** Exercise the shipped browser entry with real settings forms and menu primitives. */
import * as React from 'react'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const buildScript = resolve(import.meta.dirname, '../scripts/build-plugins.mjs')
beforeAll(() => { execFileSync(process.execPath, [buildScript, 'brand']) })

const disposers: (() => void)[] = []
afterEach(() => { cleanup(); vi.unstubAllGlobals(); disposers.splice(0).reverse().forEach(dispose => dispose()) })

async function fixture(options: { writable?: boolean; failSave?: boolean; freshBaseten?: boolean; reauthRequired?: boolean } = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('rumi-chatgpt')) return Response.json({ hasKey: true, hint: '1234' })
    const state = { connected: !options.reauthRequired, reauthRequired: options.reauthRequired }
    return Response.json(init?.method === 'POST' ? { ...state, pending: true, url: 'https://auth.openai.com/' } : state)
  })
  vi.stubGlobal('fetch', fetch)
  const configured = new Set(['DIRECT_KEY'])
  const basetenProfiles: Record<string, { apiKeyEnv: string }> = options.freshBaseten ? {} : { baseten: { apiKeyEnv: 'BASETEN_REF' } }
  const configureRoute = vi.fn(async (_ns: string, ops: { value: { apiKeyEnv: string } }[]) => {
    basetenProfiles.baseten = ops[0]!.value
    return { ok: true }
  })
  const storeKey = vi.fn(async (ref: string, _value: string) => {
    configured.add(ref)
    return { ok: true }
  })
  const scope = createSnapshotStore({ status: 'ready' as const, value: { provider: 'test', model: 'first', reasoningEffort: 'high' }, base: {}, user: {}, writable: options.writable !== false, revision: 1 })
  const mutate = vi.fn(async (ops: { op: string; path: string[]; value?: string }[], revision: number) => {
    expect(revision).toBe(1)
    if (options.failSave) return false
    const value = { ...scope.getSnapshot().value }
    for (const op of ops) {
      const field = op.path[0] as keyof typeof value
      if (op.op === 'unset') Reflect.deleteProperty(value, field)
      else value[field] = op.value!
    }
    scope.set({ ...scope.getSnapshot(), value, revision: 2 })
    return true
  })
  const catalog = { groups: [{ id: 'test', name: 'Test provider', models: [
    { id: 'first', name: 'First', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
    { id: 'second', name: 'Second' },
  ] }, { id: 'baseten', name: 'DeepSeek via Baseten', models: [{ id: 'deepseek-ai/demo', name: 'Baseten model' }] }], failures: [] }
  const modelCatalog = vi.fn(async () => ({ ok: true, value: catalog }))
  const dictionaries = new Map<string, Record<string, string>>()
  const listeners = new Map<string, () => void>()
  type FormState = { shell: SettingsFormShell; provider: string; model: string; effort: string }
  type CatalogState = { value: typeof catalog | null; failed: boolean; loading: boolean }
  type Injected = {
    hooks: { form: SnapshotStore<FormState>; catalog: SnapshotStore<CatalogState> }
    operations: {
      edit: (field: string, text: string) => void
      discard: () => void
      save: () => Promise<boolean>
      refresh: () => Promise<void>
    }
    t: (key: string) => string
  }
  type Props = Injected & {
    useForm: (select: (value: FormState) => FormState) => FormState
    useCatalog: (select: (value: CatalogState) => CatalogState) => CatalogState
  }
  let Component: React.ComponentType<Props>, injected: Injected
  const context = {
    effect(effect: () => undefined | (() => void)) { const dispose = effect(); if (dispose) disposers.push(dispose) },
    on(event: string, listener: () => void) { listeners.set(event, listener) },
    inject(_names: string[], apply: (ctx: typeof context) => void) { apply(context) },
    configForms: { get: () => ({ ...scope, mutate }) },
    remote: { session: { modelCatalog },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DIRECT_KEY' } },
        { ns: 'llm-pi-ai', revision: 7, value: { providers: basetenProfiles } },
      ] } }), mutate: configureRoute },
      credentials: {
        describe: async ([ref]: string[]) => ({
          ok: true, value: { [ref]: { configured: configured.has(ref), writable: true, source: 'file' } },
        }),
        set: storeKey,
      },
      $on(event: string, listener: () => void) {
        listeners.set(event, listener)
        return () => { listeners.delete(event) }
      } },
    locale: {
      register(ns: string, copy: { en: Record<string, string> }) { dictionaries.set(ns, copy.en); return () => {} },
      bind: (ns: string) => (key: string) => dictionaries.get(ns)?.[key] ?? key,
    },
    slots: {
      inject(name: string, register: () => (() => void)) {
        if (name === 'settings.models.footer') {
          const dispose = register()
          expect(typeof dispose).toBe('function')
          disposers.push(dispose)
        }
      },
      register(spec: { inject: () => Injected; locale: string }, component: React.ComponentType<Props>) {
        Component = component
        injected = spec.inject()
        injected.t = (key: string) => dictionaries.get(spec.locale)![key]!
        return () => {}
      },
    },
  }
  const loader = { load(module: { factory: (require: (id: string) => object) => { apply: (ctx: typeof context) => void } }) {
    module.factory((id) => {
      if (id === 'react') return React
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
      throw new Error(id)
    }).apply(context)
  } }
  new Function('window', readFileSync('apps/rumi/plugins/brand/lib/client.js', 'utf8'))({ __ModuleLoader__: loader, addEventListener() {}, removeEventListener() {} })
  function View() {
    return <Component {...injected}
      useForm={select => select(React.useSyncExternalStore(injected.hooks.form.subscribe, injected.hooks.form.getSnapshot))}
      useCatalog={select => select(React.useSyncExternalStore(injected.hooks.catalog.subscribe, injected.hooks.catalog.getSnapshot))} />
  }
  await act(async () => { render(<View />) })
  return { scope, mutate, modelCatalog, listeners, catalog, configured, storeKey, configureRoute, fetch }
}

it('offers fresh authorization from a rejected ChatGPT default without disconnecting', async () => {
  const f = await fixture({ reauthRequired: true })
  await act(async () => { f.scope.set({ ...f.scope.getSnapshot(), value: { provider: 'rumi-chatgpt', model: 'gpt-6.2-sol', reasoningEffort: 'high' } }) })
  const row = within(screen.getByText('ChatGPT plan', { selector: 'strong' }).parentElement!.parentElement!.parentElement!)
  expect(row.getByText('Sign-in required')).toBeTruthy()
  fireEvent.click(row.getByRole('button', { name: 'Sign in again' }))
  expect(await row.findByRole('link', { name: 'Continue in browser' })).toBeTruthy()
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init?.body))
    .toEqual([JSON.stringify({ action: 'start' })])
  expect(f.mutate).not.toHaveBeenCalled()
})

it('stages a new model, clears incompatible effort, and saves the default atomically', async () => {
  const f = await fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Model Test provider · First' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Second' }))
  expect(f.mutate).not.toHaveBeenCalled()
  expect(screen.queryByText('Reasoning effort')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save default' }))
  await screen.findByText('Default saved.')
  expect(f.mutate).toHaveBeenCalledWith([
    { op: 'set', path: ['model'], value: 'second' },
    { op: 'unset', path: ['reasoningEffort'] },
  ], 1)
  expect(f.scope.getSnapshot().value.model).toBe('second')
})

it('offers only advertised effort and retains the draft after a refused save', async () => {
  const f = await fixture({ failSave: true })
  fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort High' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Model default', 'Low', 'High'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Low' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save default' }))
  await screen.findByText('Could not save the default. Check your connection and try again.')
  expect(screen.getByRole('button', { name: 'Reasoning effort Low' })).toBeTruthy()
  expect(f.scope.getSnapshot().value.reasoningEffort).toBe('high')
})

it('keeps read-only defaults visible and refreshes after settings change', async () => {
  const f = await fixture({ writable: false })
  expect(screen.getByRole('button', { name: 'Model Test provider · First' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Save default' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { f.listeners.get('settings/document-updated')!() })
  await waitFor(() => expect(f.modelCatalog).toHaveBeenCalledTimes(2))
})

it('preserves an unavailable saved route and prevents saving until a valid model is chosen', async () => {
  const f = await fixture()
  await act(async () => { f.scope.set({ ...f.scope.getSnapshot(), value: { provider: 'removed', model: 'missing', reasoningEffort: 'high' } }) })
  expect(screen.getByRole('button', { name: 'Model Saved model unavailable' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save default' }).hasAttribute('disabled')).toBe(true)
  expect(f.mutate).not.toHaveBeenCalled()
})

it('ignores stale catalog responses after a newer refresh and reports load failures', async () => {
  const f = await fixture()
  const older = Promise.withResolvers<Awaited<ReturnType<typeof f.modelCatalog>>>()
  f.modelCatalog.mockImplementationOnce(() => older.promise)
  await act(async () => { f.listeners.get('settings/document-updated')!() })
  f.modelCatalog.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { f.listeners.get('connection/reset')!() })
  expect(screen.getByText('Could not load all models. Retry to refresh the list.')).toBeTruthy()
  await act(async () => { older.resolve({ ok: true, value: f.catalog }) })
  expect(screen.queryByRole('button', { name: 'Model Test provider · First' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Model Test provider · First' })
})

it('keeps independent connections when configuring a second API provider', async () => {
  const f = await fixture()
  const row = (name: string) => within(screen.getByText(name, { selector: 'strong' }).parentElement!.parentElement!.parentElement!)
  expect(row('ChatGPT plan').getByText('Configured')).toBeTruthy()
  expect(row('DeepSeek API').getByText('Configured')).toBeTruthy()
  fireEvent.click(row('DeepSeek via Baseten').getByRole('button', { name: 'Connect' }))
  fireEvent.change(row('DeepSeek via Baseten').getByLabelText('API key'), { target: { value: 'test-only' } })
  fireEvent.click(row('DeepSeek via Baseten').getByRole('button', { name: 'Save key' }))
  await waitFor(() => expect(row('DeepSeek via Baseten').getByRole('button', { name: 'Manage' })).toBeTruthy())
  expect(f.storeKey).toHaveBeenCalledWith('BASETEN_REF', 'test-only')
  expect([...f.configured]).toEqual(['DIRECT_KEY', 'BASETEN_REF'])
  expect(f.mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Model Test provider · First' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Baseten model' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save default' }))
  await screen.findByText('Default saved.')
  expect(f.scope.getSnapshot().value.provider).toBe('baseten')
  expect(f.storeKey).toHaveBeenCalledTimes(1)
  expect(screen.getAllByText('Configured')).toHaveLength(3)
  expect(screen.getAllByRole('heading').map(heading => heading.textContent)).toMatchInlineSnapshot(`
    [
      "Project conversations",
      "Provider connections",
      "Live voice",
    ]
  `)
})

it('creates a scoped Baseten route on first connection without changing the default', async () => {
  const f = await fixture({ freshBaseten: true })
  const row = within(screen.getByText('DeepSeek via Baseten', { selector: 'strong' }).parentElement!.parentElement!.parentElement!)
  fireEvent.click(row.getByRole('button', { name: 'Connect' }))
  fireEvent.change(row.getByLabelText('API key'), { target: { value: 'demo' } })
  fireEvent.click(row.getByRole('button', { name: 'Save key' }))
  await waitFor(() => expect(row.getByRole('button', { name: 'Manage' })).toBeTruthy())
  expect(f.configureRoute).toHaveBeenCalledWith('llm-pi-ai', [{
    op: 'set', path: ['providers', 'baseten'], value: {
      displayName: 'DeepSeek via Baseten', apiKeyEnv: 'BASETEN_API_KEY',
      models: [{
        id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast', name: 'DeepSeek V4.1 Flash 1017 Fast',
        contextWindow: 1048576, input: ['text', 'image'],
        reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
        compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true,
          requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'openai', maxTokensField: 'max_tokens' },
      }, { id: 'deepseek-ai/DeepSeek-V4-Pro' }],
    },
  }], 7)
  expect(f.storeKey).toHaveBeenCalledWith('BASETEN_API_KEY', 'demo')
  expect(f.mutate).not.toHaveBeenCalled()
})
