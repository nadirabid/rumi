/** Packaged client events preserve graph delivery without filesystem polling. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import type { PluginEvents } from '@deepseek-ai/dsh-client-hmr/src/plugin-events.ts'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import * as events from '../brand/client-events/index.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

async function mount(watchBundles = false, bundle?: string) {
  const ctx = new Context()
  let revision = 'initial'
  const graph = () => ({ rev: revision, entries: [{ id: 'test-bundle', url: 'test.js', rev: revision }], batches: [] })
  const graphListeners = new Set<() => void>()
  const rebuildListeners = new Set<(id: string, rev: string) => void>()
  const artifactBaseline = vi.fn(() => {
    if (bundle === undefined) return undefined
    const stat = statSync(bundle)
    return { path: bundle, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size }
  })
  const rebuilt = vi.fn()
  ctx.provide('clientModules', {
    graph,
    graphFor: graph,
    artifactBaseline, rebuilt,
    onGraphChanged(listener: () => void) { graphListeners.add(listener); return () => graphListeners.delete(listener) },
    onRebuilt(listener: (id: string, rev: string) => void) {
      rebuildListeners.add(listener)
      return () => rebuildListeners.delete(listener)
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'client', import: async () => events } as never
  vi.stubEnv('RUMI_DEVELOPMENT', watchBundles ? '1' : '0')
  const patches = loadOptionalPatches('rumi', fileURLToPath(new URL('../brand/client-events/cordis.patch.yml', import.meta.url)))!
  const rows = composeEntries([[{ insert: [
    { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
    { id: 'typert-loader', name: '@deepseek-ai/dsh-typert-loader' },
  ] }], patches])
  expect(rows.find(row => row.id === 'client-hmr')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'typert-loader')?.config).toEqual({ packages: ['@deepseek-ai/dsh-client-hmr'] })
  const row = rows.find(row => row.id === 'rumi-client-events')!
  expect(row.name).toBe('@rumi/client-events')
  const id = await ctx.loader.create(row)
  await ctx.loader.resolve(id).fiber!.await()
  const service = ctx.get('pluginEvents') as PluginEvents
  return {
    ctx, artifactBaseline, rebuilt, graphListeners, rebuildListeners,
    follow: (signal: AbortSignal) => service.follow(signal)[Symbol.asyncIterator](),
    changed() { revision = 'changed'; for (const listener of graphListeners) listener() },
    rebuiltEvent() { for (const listener of rebuildListeners) listener('test-bundle', 'next') },
  }
}

it('mounts the stock Remote event stream without watching packaged bundles', async () => {
  const f = await mount()
  const controller = new AbortController()
  try {
    const follower = f.follow(controller.signal)
    expect(await follower.next()).toMatchObject({ done: false, value: { type: 'baseline', graph: { rev: 'initial' } } })
    f.changed()
    expect(await follower.next()).toMatchObject({ done: false, value: { type: 'graph', graph: { rev: 'changed' } } })
    f.rebuiltEvent()
    expect(await follower.next()).toEqual({ done: false, value: { type: 'rebuilt', id: 'test-bundle', rev: 'next' } })
    expect(f.artifactBaseline).not.toHaveBeenCalled()
    expect(f.rebuilt).not.toHaveBeenCalled()
    const pending = follower.next()
    await f.ctx.fiber.dispose()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(f.graphListeners.size).toBe(0)
    expect(f.rebuildListeners.size).toBe(0)
  } finally {
    controller.abort()
    await f.ctx.fiber.dispose()
  }
})

it('retains the stock development bundle watcher and releases its timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rumi-client-events-'))
  const bundle = join(root, 'client.js')
  writeFileSync(bundle, 'initial')
  vi.useFakeTimers()
  const intervals = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const f = await mount(true, bundle)
  try {
    expect(f.artifactBaseline).toHaveBeenCalledTimes(1)
    writeFileSync(bundle, 'changed bundle bytes')
    await vi.advanceTimersByTimeAsync(500)
    expect(f.rebuilt).toHaveBeenCalledWith('test-bundle')
    await f.ctx.fiber.dispose()
    expect(intervals).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledWith(intervals.mock.results[0].value)
  } finally {
    await f.ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
