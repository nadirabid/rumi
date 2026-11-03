/** Source snapshots remain consistent across edits and disappear on disposal. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSource } from '../viewer/source.js'

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
  const request = { path: state.path, revision: state.revision, url: state.url, label: 'Top', blobs: [
    { center: [0, 0, 3], radii: [5, 5, 1], rotationDegrees: [0, 0, 0] },
  ] }
  expect(f.source.highlight(request).status).toBe('queued')
  const highlight = f.source.state().highlight
  expect(f.source.highlight({ ...request, url: '/other-instance' }).status).toBe('stale_model')
  expect(() => f.source.highlight({ ...request, blobs: [{ ...request.blobs[0], radii: [0, 1, 1] }] })).toThrow('radii')
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
  expect(f.source.highlight({ ...request, ...current, label: '', blobs: [] }).status).toBe('cleared')
})
