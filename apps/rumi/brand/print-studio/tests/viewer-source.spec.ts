/** Source snapshots remain consistent across edits and disappear on disposal. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../viewer/source.js'
import { modelRegionAt } from '../viewer/model-regions.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rumi-model-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'source')
  await mkdir(directory)
  await writeFile(join(directory, 'model.js'), "import { size } from './part.js'; export function build(THREE) { return new THREE.Mesh(new THREE.BoxGeometry(size, 2, 3)); }")
  await writeFile(join(directory, 'part.js'), 'export const size = 10')
  const routes = new Map<string, () => Promise<Response>>()
  const lifecycle = new Context()
  cleanup.push(() => lifecycle.fiber.dispose())
  const ctx = { effect: lifecycle.effect.bind(lifecycle), connection: { fetch: {
    register: (route: { path: string; fetch: () => Promise<Response> }) => {
      routes.set(route.path, route.fetch)
      return async () => { routes.delete(route.path) }
    },
  } } }
  const source = await createSource(ctx, join(directory, 'model.js'), root)
  cleanup.push(() => source.dispose())
  return { root, directory, routes, ctx, source, lifecycle }
}

it('publishes immutable relative modules and debounces source changes', async () => {
  const f = await fixture()
  const before = f.source.state()
  expect(await (await f.routes.get(before.url)!()).text()).toContain("'./part.js'")
  await writeFile(join(f.directory, 'part.js'), 'export const size = 20')
  await f.source.poll()
  expect(f.source.state().url).toBe(before.url)
  await f.source.poll()
  const after = f.source.state()
  expect(after.revision).toBe(before.revision + 1)
  expect(await (await f.routes.get(after.url.replace('model.js', 'part.js'))!()).text()).toContain('20')
  expect(await (await f.routes.get(before.url.replace('model.js', 'part.js'))!()).text()).toContain('10')
  await f.source.dispose()
  expect(f.routes.size).toBe(0)
})

it('retains placement and last source through failures and reports recovery', async () => {
  const f = await fixture()
  const before = f.source.state()
  f.source.transform({ scale: 2, rotate: { z: 30 } })
  f.source.feedback({ revision: before.revision, url: before.url, transform: f.source.state().transform, error: 'broken build' })
  await f.source.poll()
  expect(f.source.state().error).toEqual({ kind: 'build', message: 'broken build' })
  await rm(join(f.directory, 'model.js'))
  await f.source.poll()
  expect(f.source.state()).toMatchObject({ url: before.url, transform: f.source.state().transform, error: { kind: 'source' } })
  await writeFile(join(f.directory, 'model.js'), 'export function build() {}')
  await f.source.poll()
  await f.source.poll()
  expect(f.source.state()).toMatchObject({ error: null, transform: { scale: 2, rotate: { z: 30 } } })
  f.source.feedback({ revision: before.revision, url: before.url, transform: f.source.state().transform, error: 'stale' })
  expect(f.source.state().error).toBeNull()
})

it('refuses sources outside the project and symlinked dependencies', async () => {
  const f = await fixture()
  await expect(createSource(f.ctx, join(f.directory, 'model.js'), join(f.root, 'missing'))).rejects.toThrow()
  await symlink(join(f.directory, 'model.js'), join(f.directory, 'alias.js'))
  await f.source.poll()
  expect(f.source.state().error).toMatchObject({ kind: 'source', message: expect.stringContaining('symbolic') })
})


it('removes live snapshot routes when the Cordis owner unloads', async () => {
  const f = await fixture()
  expect(f.routes.size).toBe(2)
  await f.lifecycle.fiber.dispose()
  expect(f.routes.size).toBe(0)
  await writeFile(join(f.directory, 'part.js'), 'export const size = 100')
  await f.source.poll()
  expect(f.routes.size).toBe(0)
})

it('drains an admitted source poll during unload without registering another snapshot', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'part.js'), 'export const size = 30')
  await f.source.poll()
  const polling = f.source.poll()
  await f.lifecycle.fiber.dispose()
  await polling
  expect(f.routes.size).toBe(0)
  expect(f.source.state().revision).toBe(1)
})

it('retains a build error when an unreadable source is restored unchanged', async () => {
  const f = await fixture()
  const state = f.source.state()
  f.source.feedback({ ...state, error: 'broken build' })
  const original = await (await f.routes.get(state.url)!()).text()
  await rm(join(f.directory, 'model.js'))
  await f.source.poll()
  expect(f.source.state().error.kind).toBe('source')
  await writeFile(join(f.directory, 'model.js'), original)
  await f.source.poll()
  expect(f.source.state().error).toEqual({ kind: 'build', message: 'broken build' })
})

it('binds temporary regions to a source instance and invalidates them after edits', async () => {
  const f = await fixture()
  const state = f.source.state()
  const request = { path: state.path, revision: state.revision, url: state.url, label: 'Top', meshPath: 'top.stl', triangleCount: 2 }
  expect(f.source.highlight(request).status).toBe('queued')
  const highlight = f.source.state().highlight
  expect(f.source.highlight({ ...request, url: '/other-instance' }).status).toBe('stale_model')
  expect(() => f.source.highlight({ ...request, label: ' ' })).toThrow('label')
  expect(f.source.state().highlight).toEqual(highlight)
  f.source.transform({ scale: 2 })
  expect(f.source.state().highlight).toEqual(highlight)
  await writeFile(join(f.directory, 'part.js'), 'export const size = 25')
  await f.source.poll()
  expect(f.source.highlight(request).status).toBe('stale_model')
  await f.source.poll()
  expect(f.source.state().highlight).toBeNull()
  expect(f.source.highlight(request).status).toBe('stale_model')
  const current = f.source.state()
  expect(f.source.highlight({ ...request, ...current, label: '', meshPath: '' }).status).toBe('cleared')
})


it('pins an accepted snapshot across cache eviction and releases its routes after the last retain', async () => {
  const f = await fixture(), initial = f.source.state()
  const release = f.source.retainSnapshot()
  for (let index = 0; index < 10; index++) {
    await writeFile(join(f.directory, 'part.js'), `export const size = ${index}`)
    await f.source.poll(); await f.source.poll()
  }
  expect(f.routes.has(initial.url)).toBe(true)
  await release(); await release()
  expect(f.routes.has(initial.url)).toBe(false)
})


it('reuses unchanged USD bytes but rereads them for explicit validation', async () => {
  const f = await fixture(), path = join(f.directory, 'model.usda')
  await writeFile(path, '#usda 1.0\n# revision 0\n')
  const source = await createSource(f.ctx, path, f.root)
  cleanup.push(() => source.dispose())
  const read = vi.spyOn(fsPromises, 'readFile')
  syncBuiltinESMExports()
  try {
    await source.poll(); await source.poll()
    expect(read).not.toHaveBeenCalled()
    await source.poll({ force: true })
    expect(read).toHaveBeenCalledTimes(1)
    await writeFile(path, '#usda 1.0\n# revision 1\n')
    const before = source.state()
    await source.poll()
    expect(source.state().url).toBe(before.url)
    await source.poll()
    expect(source.state().revision).toBe(before.revision + 1)
    expect(read).toHaveBeenCalledTimes(2)
  } finally { read.mockRestore(); syncBuiltinESMExports() }
})

it('loads hover names separately from USD and clears them for a different revision', async () => {
  const f = await fixture(), path = join(f.directory, 'model.usda'), metadata = join(f.directory, 'model.regions.json')
  await writeFile(path, '#usda 1.0\n# revision 0\n')
  const source = await createSource(f.ctx, path, f.root)
  cleanup.push(() => source.dispose())
  const initial = source.state()
  expect(initial.regionStatus).toBe('missing')
  const region = { id: 'tip', name: 'Tail tip', boxes: [[-1, -1, 8, 1, 1, 10]] }
  const tail = { id: 'tail', name: 'Tail', boxes: [[-2, -2, 4, 2, 2, 11]] }
  const map = { sourceHash: initial.contentHash, regions: [region, tail], remainder: 'Body' }
  await writeFile(metadata, JSON.stringify(map))
  await source.poll()
  const named = source.state()
  expect(named).toMatchObject({ url: initial.url, revision: initial.revision, regionStatus: 'ready' })
  expect(modelRegionAt(named.regionMap, [0, 0, 9]).name).toBe('Tail tip')
  expect(modelRegionAt(named.regionMap, [0, 0, 6]).name).toBe('Tail')
  expect(modelRegionAt(named.regionMap, [0, 0, 2]).name).toBe('Body')
  await writeFile(metadata, JSON.stringify({ ...map, regions: [region, region] }))
  await source.poll()
  expect(source.state()).toMatchObject({ regionStatus: 'invalid', regionMap: null, error: null })
  await writeFile(metadata, JSON.stringify(map))
  await writeFile(path, '#usda 1.0\n# revision 1\n')
  await source.poll()
  await source.poll()
  expect(source.state()).toMatchObject({ revision: initial.revision + 1, regionStatus: 'outdated', regionMap: null })
})

it('reports invalid or escaped USD changes instead of serving a cached success', async () => {
  const f = await fixture(), path = join(f.directory, 'model.usda')
  await writeFile(path, '#usda 1.0\n# revision 0\n')
  const source = await createSource(f.ctx, path, f.root)
  cleanup.push(() => source.dispose())
  const original = source.state()
  await writeFile(path, 'invalid')
  await source.poll()
  expect(source.state()).toMatchObject({ url: original.url, error: { kind: 'source' } })
  await rm(path)
  await writeFile(join(f.root, 'outside.usda'), '#usda 1.0\n')
  await symlink(join(f.root, 'outside.usda'), path)
  await source.poll()
  expect(source.state().error).toMatchObject({ kind: 'source', message: expect.stringContaining('inside its model folder') })
})


it('forces a byte read when another ordinary poll takes over during pending cleanup', async () => {
  const f = await fixture(), path = join(f.directory, 'model.usda')
  await writeFile(path, '#usda 1.0\n')
  const source = await createSource(f.ctx, path, f.root)
  cleanup.push(() => source.dispose())
  const read = vi.spyOn(fsPromises, 'readFile')
  syncBuiltinESMExports()
  const originalFinally = Promise.prototype.finally
  let reentrant: Promise<void> | undefined
  // Admit another poll exactly after the old owner clears pending, before its waiters resume.
  const handoff = vi.spyOn(Promise.prototype, 'finally').mockImplementationOnce(function (onFinally) {
    return originalFinally.call(this, () => {
      const result = onFinally?.()
      reentrant = source.poll()
      return result
    })
  })
  try {
    let ordinary: Promise<void>
    try { ordinary = source.poll() } finally { handoff.mockRestore() }
    const forced = source.poll({ force: true })
    await Promise.all([ordinary, forced])
    await reentrant
    expect(read).toHaveBeenCalledTimes(1)
  } finally { handoff.mockRestore(); read.mockRestore(); syncBuiltinESMExports() }
})
