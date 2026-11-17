// @vitest-environment jsdom
/** Exercise the shipped browser entry with real settings forms and menu primitives. */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

const disposers: (() => void)[] = []
afterEach(() => { cleanup(); disposers.splice(0).reverse().forEach(dispose => dispose()) })

async function fixture(options: { writable?: boolean; failSave?: boolean } = {}) {
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
  ] }], failures: [] }
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
    remote: { session: { modelCatalog }, $on(event: string, listener: () => void) {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    } },
    locale: { register(ns: string, copy: { en: Record<string, string> }) { dictionaries.set(ns, copy.en); return () => {} }, bind: () => () => '' },
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
  new Function('window', readFileSync('apps/rumi/brand/client.js', 'utf8'))({ __ModuleLoader__: loader, addEventListener() {}, removeEventListener() {} })
  function View() {
    return <Component {...injected}
      useForm={select => select(React.useSyncExternalStore(injected.hooks.form.subscribe, injected.hooks.form.getSnapshot))}
      useCatalog={select => select(React.useSyncExternalStore(injected.hooks.catalog.subscribe, injected.hooks.catalog.getSnapshot))} />
  }
  await act(async () => { render(<View />) })
  return { scope, mutate, modelCatalog, listeners, catalog }
}

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

it('renders the default settings explanation and named controls', async () => {
  await fixture()
  expect(screen.getByRole('region', { name: 'Default model' }).textContent).toMatchInlineSnapshot('"Default modelUsed for new conversations. Existing conversations keep their model and effort.ModelTest provider · FirstReasoning effortHighSave default"')
})
