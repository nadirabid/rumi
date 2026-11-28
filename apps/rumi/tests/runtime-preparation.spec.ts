/** Desktop resource preparation publishes versions only for complete resources. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  root: '',
  target: 'mac-arm64' as 'mac-arm64' | 'mac-x64' | 'win-x64',
  pnpm: '11.7.0' as string | undefined,
  failure: undefined as 'electron' | 'primary' | 'bullet' | 'cli' | undefined,
  downloadElectron: vi.fn(),
  preparePrimary: vi.fn(),
  prepareCad: vi.fn(),
  prepareBullet: vi.fn(),
  commandLink: vi.fn(),
}))
vi.mock('../scripts/desktop-build-paths.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/desktop-build-paths.mjs')>(),
  resolveDesktopBuildTarget: () => state.target,
  resolveDesktopTargetBuildPaths: () => ({
    runtime: join(state.root, 'runtime'), electron: join(state.root, 'electron'), downloads: join(state.root, 'downloads'),
  }),
}))
vi.mock('@electron/get', () => ({ downloadArtifact: state.downloadElectron }))
vi.mock('extract-zip', () => ({ default: async () => {
  if (state.failure === 'electron') throw new Error('Electron extraction failed')
} }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: (file: string) => file === '/usr/libexec/PlistBuddy' ? '12.0\n' : '24.18.1\n',
}))
vi.mock('../scripts/prepare-command-link.ts', () => ({ prepareCommandLink: state.commandLink }))
// The compiled command manager is a build input; all source resource copies use real files.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, cpSync: (...args: Parameters<typeof actual.cpSync>) => {
    if (String(args[0]).endsWith(join('lib', 'command-manager-entry.js'))) {
      if (state.failure === 'cli') throw new Error('command manager copy failed')
      actual.writeFileSync(args[1], 'command manager fixture')
    } else actual.cpSync(...args)
  } }
})
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({
  preparePrimaryRuntime: state.preparePrimary,
}))
vi.mock('../scripts/prepare-cad-runtime.ts', () => ({ prepareCadRuntime: state.prepareCad }))
vi.mock('../scripts/prepare-bullet-runtime.ts', () => ({ prepareBulletRuntime: state.prepareBullet }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.root = mkdtempSync(join(tmpdir(), 'desktop-runtime-preparation-'))
  state.target = 'mac-arm64'
  state.pnpm = '11.7.0'
  state.failure = undefined
  vi.stubEnv('DSH_DESKTOP_PACKAGING_RUN_DIR', undefined)
  state.downloadElectron.mockResolvedValue('electron.zip')
  state.prepareCad.mockResolvedValue(undefined)
  state.prepareBullet.mockImplementation(async () => {
    if (state.failure === 'bullet') throw new Error('Bullet preparation failed')
    mkdirSync(join(state.root, 'runtime', 'bullet'), { recursive: true })
  })
  state.preparePrimary.mockImplementation(async () => {
    if (state.failure === 'primary') throw new Error('primary preparation failed')
    const root = join(state.root, 'runtime', 'primary-runtime')
    const pnpm = join(root, 'dependencies', 'pnpm', 'bin')
    mkdirSync(pnpm, { recursive: true })
    writeFileSync(join(pnpm, 'pnpm.mjs'), '')
    writeFileSync(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: state.target === 'win-x64' ? 'win32' : 'darwin',
      arch: state.target === 'mac-arm64' ? 'arm64' : 'x64',
      python: '3.12.14', node: '24.17.0', pnpm: state.pnpm, pythonPackages: { numpy: '2.3.5' },
    }))
  })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(state.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
})

it.each(['mac-arm64', 'mac-x64'] as const)('prepares %s with one pnpm distribution and its CLI resources', async (target) => {
  state.target = target
  const runtime = join(state.root, 'runtime')
  mkdirSync(join(runtime, 'pnpm'), { recursive: true })
  const { prepareDesktopRuntime } = await import('../scripts/prepare-runtime.ts')
  await prepareDesktopRuntime(false)
  expect(existsSync(join(runtime, 'pnpm'))).toBe(false)
  expect(existsSync(join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))).toBe(true)
  expect(existsSync(join(runtime, 'bin', 'node'))).toBe(true)
  expect(existsSync(join(runtime, 'cli', 'bin', 'dsh'))).toBe(true)
  expect(readFileSync(join(runtime, 'cli', 'command-manager.js'), 'utf8')).toBe('command manager fixture')
  expect(JSON.parse(readFileSync(join(runtime, 'versions.json'), 'utf8'))).toEqual({
    schemaVersion: 1, node: '24.18.1', pnpm: '11.7.0',
  })
  expect(state.preparePrimary).toHaveBeenCalledWith({ deferSmoke: false })
  expect(state.prepareBullet).toHaveBeenCalledWith(target, runtime, join(state.root, 'downloads'), '12.0')
  expect(state.commandLink).toHaveBeenCalledWith(join(runtime, 'cli'), target === 'mac-arm64' ? 'arm64' : 'x64', '12.0')
})

it.each([
  ['electron', 'Electron extraction failed'],
  ['primary', 'primary preparation failed'],
  ['bullet', 'Bullet preparation failed'],
  ['cli', 'command manager copy failed'],
] as const)('does not publish versions when %s preparation fails', async (failure, error) => {
  state.failure = failure
  const runtime = join(state.root, 'runtime')
  mkdirSync(runtime)
  writeFileSync(join(runtime, 'versions.json'), 'stale versions')
  const { prepareDesktopRuntime } = await import('../scripts/prepare-runtime.ts')
  const preparing = prepareDesktopRuntime(false)
  if (failure === 'cli') await expect(preparing).rejects.toThrow(error)
  else await expect(preparing).rejects.toMatchObject({ errors: [new Error(error)] })
  expect(existsSync(join(runtime, 'versions.json'))).toBe(false)
})

it.each([
  ['not-a-version', 'primary runtime: invalid metadata'],
  [undefined, 'primary-runtime manifest has no pnpm version'],
])('rejects pnpm metadata %s even when Windows smoke is deferred', async (pnpm, error) => {
  state.target = 'win-x64'
  state.pnpm = pnpm
  const { prepareDesktopRuntime } = await import('../scripts/prepare-runtime.ts')
  await expect(prepareDesktopRuntime(true)).rejects.toThrow(error)
  expect(existsSync(join(state.root, 'runtime', 'versions.json'))).toBe(false)
})

it('starts independent runtimes while Electron is downloading and drains them on failure', async () => {
  const runtime = join(state.root, 'runtime')
  const downloads = join(state.root, 'downloads')
  const electron = Promise.withResolvers<string>()
  const primary = Promise.withResolvers<void>()
  const cad = Promise.withResolvers<void>()
  const bullet = Promise.withResolvers<void>()
  state.downloadElectron.mockReturnValueOnce(electron.promise)
  state.preparePrimary.mockReturnValueOnce(primary.promise)
  state.prepareCad.mockReturnValueOnce(cad.promise)
  state.prepareBullet.mockReturnValueOnce(bullet.promise)
  const { prepareDesktopRuntime } = await import('../scripts/prepare-runtime.ts')
  const complete = vi.fn<(outcome: unknown) => void>()
  const preparing = prepareDesktopRuntime(false).then(complete, complete)
  try {
    expect(state.preparePrimary).toHaveBeenCalledWith({ deferSmoke: false })
    expect(state.prepareCad).toHaveBeenCalledWith('mac-arm64', runtime, downloads)
    expect(state.prepareBullet).not.toHaveBeenCalled()

    electron.resolve('electron.zip')
    await vi.waitFor(() => {
      expect(state.prepareBullet).toHaveBeenCalledWith('mac-arm64', runtime, downloads, '12.0')
    })

    primary.reject(new Error('primary preparation failed'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(complete).not.toHaveBeenCalled()
    expect(existsSync(runtime)).toBe(true)
    expect(existsSync(join(runtime, 'versions.json'))).toBe(false)
  } finally {
    electron.resolve('electron.zip')
    primary.resolve()
    cad.resolve()
    bullet.resolve()
    await preparing
  }
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ errors: [new Error('primary preparation failed')] }))
  expect(existsSync(runtime)).toBe(false)
})
