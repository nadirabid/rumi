/** Packaged modeling resolves its own runtime even when a separate Blender is installed. */
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { smokeBlenderRuntime } from '../scripts/prepare-blender-runtime.ts'

it('uses the packaged Blender, honors explicit overrides, and exposes a damaged bundle instead of falling back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-runtime-resolution-'))
  try {
    const modulePath = join(root, 'app.asar', 'dsh', 'blender', 'host.mjs')
    await mkdir(dirname(modulePath), { recursive: true })
    await copyFile(new URL('../brand/print-studio/blender/host.js', import.meta.url), modulePath)
    const { blenderStatus } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    const executable = join(root, 'runtime', 'blender', process.platform === 'win32' ? 'Blender/blender.exe' : 'blender')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fixture executable', { mode: 0o755 })
    const status = await blenderStatus('', root)
    expect(status.status).toBe('ready')
    expect(status.executable).toContain(join('runtime', 'blender'))
    expect(status.helper).toContain(join('app.asar.unpacked', 'dsh', 'blender'))
    expect(await blenderStatus(process.execPath, root)).toMatchObject({ status: 'ready', executable: process.execPath })
    await rm(executable)
    expect(await blenderStatus('', root)).toMatchObject({ status: 'bundled_unavailable' })
    expect(await blenderStatus('/missing/explicit-Blender', root)).toMatchObject({ status: 'invalid_executable' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects an incomplete packaged Blender before trying to execute it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-incomplete-blender-'))
  try {
    await mkdir(join(root, 'runtime', 'blender'), { recursive: true })
    await writeFile(join(root, 'runtime', 'blender', 'runtime.json'), JSON.stringify({ version: '4.5.15', target: 'mac-arm64' }))
    expect(() => smokeBlenderRuntime(root, 'mac-arm64')).toThrow('Packaged Blender resource is missing')
  } finally { await rm(root, { recursive: true, force: true }) }
})
