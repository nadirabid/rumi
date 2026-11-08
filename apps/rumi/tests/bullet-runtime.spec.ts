/** Native Bullet packaging retains verified inputs and refuses incomplete or incompatible payloads. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import lock from '../scripts/bullet-runtime.lock.json' with { type: 'json' }

const state = vi.hoisted(() => ({ root: '', compileFails: false, identity: { protocolVersion: 2, bulletVersion: 326, precision: 'double', ok: true },
  exec: vi.fn<(file: string, args: string[]) => string>(), download: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: state.exec }))
vi.mock('../../../scripts/primary-runtime/prepare.ts', () => ({ downloadPrimaryRuntimeAsset: state.download }))
vi.mock('tar', () => ({ x: async ({ cwd }: { cwd: string }) => {
  writeFileSync(join(cwd, 'LICENSE.txt'), 'Bullet license fixture')
} }))
vi.mock('extract-zip', () => ({ default: async (_archive: string, { dir }: { dir: string }) => {
  const bin = join(dir, 'cmake', 'data', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, process.platform === 'win32' ? 'cmake.exe' : 'cmake'), 'CMake fixture')
} }))
import { bulletBuildTarget, prepareBulletRuntime, smokeBulletRuntime } from '../scripts/prepare-bullet-runtime.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const nativeTarget = process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
const minimumMacOSVersion = process.platform === 'win32' ? undefined : '12.0'
const nativeBuildHost = process.platform === 'darwin' || process.platform === 'win32'

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'rumi-bullet-runtime-'))
  state.compileFails = false
  state.identity = { protocolVersion: 2, bulletVersion: 326, precision: 'double', ok: true }
  state.exec.mockReset()
  state.download.mockReset()
  state.download.mockImplementation(async (_url: string, digest: string) => {
    const path = join(state.root, digest)
    writeFileSync(path, 'verified asset fixture')
    return path
  })
  state.exec.mockImplementation((_file: string, args: string[]) => {
    if (args[0] === '--build') {
      if (state.compileFails) throw new Error('Native compiler failed')
      const output = args[1]
      if (output === undefined) throw new Error('Build command requires an output directory')
      const bin = join(output, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, process.platform === 'win32' ? 'rumi-bullet.exe' : 'rumi-bullet'), 'native helper fixture')
    }
    return JSON.stringify(state.identity)
  })
})

afterEach(async () => { await rm(state.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) })

it('selects native compiler architectures and refuses a foreign operating system', () => {
  expect(bulletBuildTarget('mac-arm64', 'darwin', '12.0', '/SDK')).toMatchObject({ platform: 'darwin', executable: 'rumi-bullet',
    arguments: ['-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0', '-DCMAKE_OSX_SYSROOT=/SDK'] })
  expect(bulletBuildTarget('mac-x64', 'darwin', '12.0').arguments).toEqual(['-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'])
  expect(bulletBuildTarget('win-x64', 'win32', undefined)).toMatchObject({ platform: 'win32', executable: 'rumi-bullet.exe',
    arguments: ['-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'] })
  expect(() => bulletBuildTarget('win-x64', 'darwin', undefined)).toThrow('matching the target operating system')
  expect(() => bulletBuildTarget('mac-arm64', 'linux', '12.0')).toThrow('matching the target operating system')
})

it.each([undefined, 'invalid'])('requires the application minimum macOS version before selecting compiler flags (%s)', (version) => {
  expect(() => bulletBuildTarget('mac-arm64', 'darwin', version)).toThrow('Electron minimum macOS version')
})

// Cross-OS compiler execution is not supported; target selection is covered independently above.
it.skipIf(!nativeBuildHost)('stages verified dependency inputs, licenses and the native helper outside build tools', async () => {
  const runtime = join(state.root, 'runtime'), cache = join(state.root, 'cache')
  await prepareBulletRuntime(nativeTarget, runtime, cache, minimumMacOSVersion)
  const payload = join(runtime, 'bullet')
  expect(readdirSync(runtime)).toEqual(['bullet'])
  expect(readdirSync(payload).sort()).toEqual(['README.txt', 'bin', 'licenses', 'runtime.json'])
  expect(readFileSync(join(payload, 'licenses', 'Bullet-LICENSE.txt'), 'utf8')).toBe('Bullet license fixture')
  expect(JSON.parse(readFileSync(join(payload, 'runtime.json'), 'utf8'))).toMatchObject({ target: nativeTarget, source: lock.source,
    json: lock.json, protocolVersion: 2, bulletVersion: 326, precision: 'double' })
  expect(state.download).toHaveBeenCalledWith(lock.source.url, lock.source.sha256, cache)
  expect(state.download).toHaveBeenCalledWith(lock.json.header.url, lock.json.header.sha256, cache)
  smokeBulletRuntime(state.root, nativeTarget)
  expect(state.exec.mock.calls.some(([, args]) => args[0] === '--self-test')).toBe(true)
  if (process.platform === 'darwin') expect(state.exec.mock.calls.some(([file]) => file === '/usr/bin/codesign')).toBe(true)
})

it.skipIf(!nativeBuildHost)('discards staged compiler output when native preparation fails', async () => {
  state.compileFails = true
  const runtime = join(state.root, 'runtime')
  await expect(prepareBulletRuntime(nativeTarget, runtime, join(state.root, 'cache'), minimumMacOSVersion)).rejects.toThrow('Native compiler failed')
  expect(readdirSync(runtime)).toEqual([])
})

it.skipIf(!nativeBuildHost)('refuses an existing payload without downloading or replacing it', async () => {
  const runtime = join(state.root, 'runtime')
  mkdirSync(join(runtime, 'bullet'), { recursive: true })
  writeFileSync(join(runtime, 'bullet', 'sentinel'), 'existing')
  await expect(prepareBulletRuntime(nativeTarget, runtime, join(state.root, 'cache'), minimumMacOSVersion)).rejects.toThrow('destination already exists')
  expect(state.download).not.toHaveBeenCalled()
  expect(existsSync(join(runtime, 'bullet', 'sentinel'))).toBe(true)
})

it.skipIf(!nativeBuildHost).each(['protocol', 'engine', 'precision', 'self-test'] as const)('rejects a native %s mismatch before publishing the helper', async (mismatch) => {
  if (mismatch === 'protocol') state.identity.protocolVersion = 1
  if (mismatch === 'engine') state.identity.bulletVersion = 999
  if (mismatch === 'precision') state.identity.precision = 'float'
  if (mismatch === 'self-test') state.identity.ok = false
  const runtime = join(state.root, 'runtime')
  await expect(prepareBulletRuntime(nativeTarget, runtime, join(state.root, 'cache'), minimumMacOSVersion)).rejects.toThrow('does not match the release lock')
  expect(existsSync(join(runtime, 'bullet'))).toBe(false)
})

it('rejects a damaged manifest or missing runtime resource before executing it', () => {
  const root = join(state.root, 'runtime', 'bullet')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ schemaVersion: 1, target: 'mac-arm64', protocolVersion: 2,
    bulletVersion: 326, precision: 'double', source: lock.source, json: lock.json }))
  expect(() => { smokeBulletRuntime(state.root, 'mac-x64') }).toThrow('manifest does not match')
  expect(() => { smokeBulletRuntime(state.root, 'mac-arm64') }).toThrow('resource is missing')
  expect(state.exec).not.toHaveBeenCalled()
})

it('ships runtime resources and leaves Bullet code eligible for ordinary and update-package signing', () => {
  for (const prepared of [undefined, '/private/update/dsh']) {
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.nadirmuzaffar.rumi', DSH_DESKTOP_UNSIGNED: '1' },
      'darwin', 'arm64', prepared, prepared === undefined ? undefined : 'test-version')
    expect(config.extraResources[0]?.to).toBe('runtime')
    expect(config.mac.signIgnore.some(pattern => new RegExp(pattern).test('/Rumi.app/Contents/Resources/runtime/bullet/bin/rumi-bullet'))).toBe(false)
  }
})
