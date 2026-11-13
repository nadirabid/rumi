/** Installation failures stay private and concurrent setup requests share their work. */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '', installed: false, calls: 0,
  release: null as null | (() => void) }))
vi.mock('../brand/print-studio/connect.js', () => ({
  managedAppRoot: () => fixture.root,
  findBambuConnect: () => fixture.installed ? '/existing/Bambu Connect.app' : null,
}))
vi.mock('../brand/print-studio/probe.js', () => ({
  findBambuStudio: () => fixture.installed ? '/existing/BambuStudio.app' : null,
}))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: object, callback: (error: Error) => void) => {
    fixture.calls++
    fixture.release = () => callback(new Error('download unavailable'))
  },
}))
// The plugin is shipped as JavaScript and has no generated declarations.
// @ts-expect-error JavaScript plugin module
import { connectSpec, createAppSetup, studioSpec, verifyArchive } from '../brand/print-studio/app-setup.js'

afterEach(async () => {
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  fixture.root = ''; fixture.installed = false; fixture.calls = 0; fixture.release = null
})

it('rejects modified downloads before mounting', async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'rumi-connect-test-'))
  const archive = join(fixture.root, 'archive')
  await writeFile(archive, 'verified fixture')
  const hash = createHash('sha256').update('verified fixture').digest('hex')
  await expect(verifyArchive(archive, hash)).resolves.toBeUndefined()
  await writeFile(archive, 'modified fixture')
  await expect(verifyArchive(archive, hash)).rejects.toThrow('checksum mismatch')
})

const specs = [['Bambu Connect', connectSpec], ['Bambu Studio', studioSpec]] as const
for (const [label, spec] of specs) {
  it.skipIf(process.platform !== 'darwin')(`${label}: shares a download and waits for cleanup on shutdown`, async () => {
    fixture.root = await mkdtemp(join(tmpdir(), 'rumi-connect-test-'))
    const setup = createAppSetup(spec, { downloadTimeoutSeconds: 30, downloadRetries: 0 })
    const first = setup.start()
    expect(setup.start()).toBe(first)
    await vi.waitFor(() => expect(fixture.release).not.toBeNull())
    let disposed = false
    const stopping = setup.dispose().then(() => { disposed = true })
    expect(disposed).toBe(false)
    fixture.release!()
    await stopping
    expect(fixture.calls).toBe(1)
    expect(setup.status()).toEqual({ phase: 'failed', error: 'stopped', installed: false })
    expect(await readdir(fixture.root)).toEqual([])
    expect(setup.start()).toBeUndefined()
  })

  it.skipIf(process.platform !== 'darwin')(`${label}: retains an existing app without downloading`, async () => {
    fixture.installed = true
    const setup = createAppSetup(spec, { downloadTimeoutSeconds: 30, downloadRetries: 0 })
    await setup.start()
    expect(setup.status()).toEqual({ phase: 'ready', error: null, installed: true })
    expect(fixture.calls).toBe(0)
    await setup.dispose()
  })

  it.skipIf(process.platform !== 'darwin')(`${label}: allows retry after a failed download without retaining partial files`, async () => {
    fixture.root = await mkdtemp(join(tmpdir(), 'rumi-connect-test-'))
    const setup = createAppSetup(spec, { downloadTimeoutSeconds: 30, downloadRetries: 0 })
    for (let attempt = 1; attempt <= 2; attempt++) {
      fixture.release = null
      const pending = setup.start()
      await vi.waitFor(() => expect(fixture.release).not.toBeNull())
      fixture.release!()
      await pending
      expect(setup.status()).toEqual({ phase: 'failed', error: 'setupFailed', installed: false })
      expect(await readdir(fixture.root)).toEqual([])
      expect(fixture.calls).toBe(attempt)
    }
    await setup.dispose()
  })
}
