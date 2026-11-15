/** Packaged client events preserve graph delivery without filesystem polling. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import * as events from '../brand/client-events/index.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

type Handler = (request: IncomingMessage, response: ServerResponse) => void

async function mount(watchBundles = false, bundle?: string) {
  const ctx = new Context()
  let handler: Handler | undefined
  let revision = 'initial'
  const graphListeners = new Set<() => void>()
  const rebuildListeners = new Set<(id: string, rev: string) => void>()
  const artifactBaseline = vi.fn(() => {
    if (bundle === undefined) return undefined
    const stat = statSync(bundle)
    return { path: bundle, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size }
  })
  const rebuilt = vi.fn()
  ctx.provide('clientModules', {
    graph: () => ({ rev: revision, entries: [{ id: 'test-bundle' }], batches: [] }),
    artifactBaseline, rebuilt,
    onGraphChanged(listener: () => void) { graphListeners.add(listener); return () => graphListeners.delete(listener) },
    onRebuilt(listener: (id: string, rev: string) => void) {
      rebuildListeners.add(listener)
      return () => rebuildListeners.delete(listener)
    },
  })
  ctx.provide('webServer', {
    register(route: { path: string; handler: Handler }) {
      expect(route.path).toBe('/plugins/events')
      handler = route.handler
      return () => { handler = undefined }
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'client', import: async () => events } as never
  vi.stubEnv('RUMI_DEVELOPMENT', watchBundles ? '1' : '0')
  const patches = loadOptionalPatches('rumi', fileURLToPath(new URL('../brand/client-events/cordis.patch.yml', import.meta.url)))!
  const rows = composeEntries([[{ insert: [{ id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' }] }], patches])
  expect(rows.find(row => row.id === 'client-hmr')?.disabled).toBe(true)
  const row = rows.find(row => row.id === 'rumi-client-events')!
  expect(row.name).toBe('@rumi/client-events')
  const id = await ctx.loader.create(row)
  await ctx.loader.resolve(id).fiber!.await()
  return {
    ctx, artifactBaseline, rebuilt, graphListeners, rebuildListeners,
    request: (request: IncomingMessage, response: ServerResponse) => { handler!(request, response) },
    changed() { revision = 'changed'; for (const listener of graphListeners) listener() },
    rebuiltEvent() { for (const listener of rebuildListeners) listener('test-bundle', 'next') },
    hasRoute: () => handler !== undefined,
  }
}

it('streams initial graph, graph changes and rebuilds through the shipped composition without watching bundles', async () => {
  const f = await mount()
  const server = createServer(f.request)
  const controller = new AbortController()
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server port')
    const url = `http://127.0.0.1:${address.port}/plugins/events`
    const response = await fetch(url, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    async function receive(text: string) {
      let received = ''
      while (!received.includes(text)) {
        const next = await reader.read()
        if (next.done) throw new Error('Event stream closed before its frame')
        received += next.value
      }
    }
    await receive('"rev":"initial"')
    f.changed()
    await receive('"rev":"changed"')
    f.rebuiltEvent()
    await receive('"type":"rebuilt","id":"test-bundle","rev":"next"')
    const rejected = await fetch(url, { method: 'POST' })
    expect(rejected.status).toBe(405)
    expect(f.artifactBaseline).not.toHaveBeenCalled()
    expect(f.rebuilt).not.toHaveBeenCalled()
    controller.abort()
    await reader.cancel().catch((error: unknown) => { if (!controller.signal.aborted) throw error })
    await f.ctx.fiber.dispose()
    expect(f.hasRoute()).toBe(false)
    expect(f.graphListeners.size).toBe(0)
    expect(f.rebuildListeners.size).toBe(0)
  } finally {
    controller.abort()
    await f.ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
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
