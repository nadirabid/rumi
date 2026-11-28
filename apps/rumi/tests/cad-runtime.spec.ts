/** Packaged CAD modeling resolves its own build123d runtime without leaking host Python environments. */
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import * as downloads from '../../../scripts/primary-runtime/prepare.ts'
import lock from '../scripts/cad-runtime.lock.json' with { type: 'json' }
import { prepareCadRuntime, smokeCadRuntime } from '../scripts/prepare-cad-runtime.ts'

it('drains in-flight CAD asset downloads before reporting a failure and publishes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-cad-downloads-'))
  const python = Promise.withResolvers<string>()
  const failure = new Error('wheel download failed')
  const download = vi.spyOn(downloads, 'downloadPrimaryRuntimeAsset')
    .mockReturnValueOnce(python.promise)
    .mockRejectedValue(failure)
  const complete = vi.fn<(outcome: unknown) => void>()
  const prepared = prepareCadRuntime('mac-arm64', root, root).then(complete, complete)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(complete).not.toHaveBeenCalled()
    python.resolve(join(root, 'verified-python.tar.gz'))
    await prepared
    expect(complete).toHaveBeenCalledWith(expect.any(AggregateError))
    expect(await readdir(root)).toEqual([])
  } finally {
    python.resolve(join(root, 'verified-python.tar.gz'))
    await prepared
    download.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('uses the packaged CAD runtime, honors explicit overrides, and exposes a damaged bundle instead of falling back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-cad-resolution-'))
  try {
    const modulePath = join(root, 'app.asar', 'dsh', 'cad', 'host.mjs')
    await mkdir(dirname(modulePath), { recursive: true })
    await copyFile(new URL('../plugins/print-studio/cad/host.js', import.meta.url), modulePath)
    const { cadStatus } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    const executable = join(root, 'runtime', 'cad', process.platform === 'win32' ? 'cad-python.cmd' : 'cad-python')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const status = await cadStatus('', root)
    expect(status.status).toBe('ready')
    expect(status.executable).toContain(join('runtime', 'cad'))
    expect(status.helper).toContain(join('app.asar.unpacked', 'dsh', 'cad'))
    expect(status.joints).toContain(join('app.asar.unpacked', 'dsh', 'cad'))
    expect(await cadStatus(process.execPath, root)).toMatchObject({ status: 'ready', executable: process.execPath })
    await rm(executable)
    expect(await cadStatus('', root)).toMatchObject({ status: 'bundled_unavailable' })
    expect(await cadStatus('/missing/explicit-cad-python', root)).toMatchObject({ status: 'invalid_executable' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects an incomplete packaged CAD runtime before trying to execute it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-incomplete-cad-'))
  try {
    await mkdir(join(root, 'runtime', 'cad'), { recursive: true })
    await writeFile(join(root, 'runtime', 'cad', 'runtime.json'), JSON.stringify({
      schemaVersion: 1,
      target: 'mac-arm64',
      platform: 'darwin',
      arch: 'arm64',
      python: lock.pythonVersion,
      pythonRelease: lock.pythonRelease,
      build123d: lock.build123dVersion,
      pythonPackages: lock.pythonPackages,
    }))
    expect(() => smokeCadRuntime(root, 'mac-arm64')).toThrow('Packaged CAD resource is missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
