import { writeFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { packageTarget, parseDesktopPackageInvocation } from '../scripts/package-target.ts'
import { withMacOSNotarizationProxy } from '../scripts/macos-notarization-proxy.ts'
import { packageMacOSArtifacts, type MacOSArtifactRequest } from '../scripts/package-macos.ts'

vi.mock('../scripts/macos-notarization-proxy.ts', () => ({
  withMacOSNotarizationProxy: vi.fn(async (_proxy: string | undefined, action: () => Promise<void>) => action()),
}))
vi.mock('../scripts/notarize-macos.mjs', () => ({ notarizeMacOS: vi.fn(async () => {}) }))
vi.mock('../scripts/package-macos.ts', () => ({
  packageMacOSArtifacts: vi.fn(async (request: MacOSArtifactRequest) => { await request.verifyApplication?.() }),
}))

// Keep the real orchestration and manifest reads; this suite owns no release directories or subprocesses.
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  rmSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(),
}))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

const environment = { DSH_DESKTOP_APP_ID: 'com.example.test', DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
  DOWNLOAD_TEST_ORIGIN: 'https://updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef' }

function supervisor(failure?: string) {
  vi.stubEnv('npm_execpath', 'fixture-pnpm.cjs')
  const stages: string[] = []
  const run = { directory: 'fixture-record', finish: vi.fn(),
    run: vi.fn(async (stage: string, _executable: string, _args: readonly string[], _options: { env: NodeJS.ProcessEnv }) => {
      stages.push(stage)
      if (stage === failure) throw new Error('stage refused')
    }) }
  return { run, stages }
}

it('passes assembled macOS runtime verification to the artifact lanes before recording the release', async () => {
  const { run, stages } = supervisor()
  vi.mocked(packageMacOSArtifacts).mockImplementationOnce(async (request) => {
    expect(stages.at(-1)).toContain('--config.mac.notarize=false')
    expect(request.verifyApplication).toBeDefined()
    expect(writeFileSync).not.toHaveBeenCalled()
    await request.verifyApplication?.()
    expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
    expect(writeFileSync).not.toHaveBeenCalled()
  })
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), environment, run)
  expect(packageMacOSArtifacts).toHaveBeenCalledOnce()
  expect(writeFileSync).toHaveBeenCalledOnce()
})

it('packs the existing official build without rebuilding it', async () => {
  const { run, stages } = supervisor()
  const invocation = parseDesktopPackageInvocation(['mac-arm64', '--reuse-official-build'], 'darwin', 'arm64')
  await packageTarget(invocation, environment, run)
  expect(stages[0]).toMatch(/^run release:pack --family dsh /u)
  expect(stages).not.toContain('run build:official')
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
  expect(packageMacOSArtifacts).toHaveBeenCalledOnce()
})

it.each([undefined, '5'])('sets fast ZIP compression while preserving an override of %s', async (compression) => {
  const { run } = supervisor()
  vi.mocked(packageMacOSArtifacts).mockImplementationOnce(async (request, build) => {
    await request.verifyApplication?.()
    await build({ format: 'dmg', appPath: 'dmg/Rumi.app', output: 'dmg-artifacts' })
    await build({ format: 'zip', appPath: 'zip/Rumi.app', output: 'zip-artifacts' })
  })
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), {
    ...environment,
    ...(compression === undefined ? {} : { ELECTRON_BUILDER_COMPRESSION_LEVEL: compression }),
  }, run)
  const builderEnv = (format: 'dmg' | 'zip') => run.run.mock.calls.find(([, , args]) =>
    args.includes('--prepackaged') && args.includes(format))?.[3].env
  expect(builderEnv('dmg')).toBeDefined()
  expect(builderEnv('dmg')?.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe(compression)
  expect(builderEnv('zip')?.ELECTRON_BUILDER_COMPRESSION_LEVEL).toBe(compression ?? '3')
})

it('prepares the macOS runtime while packing and drains it before reporting a pack failure', async () => {
  const { run } = supervisor()
  const runtime = Promise.withResolvers<void>()
  const pack = Promise.withResolvers<void>()
  run.run.mockImplementation(async (stage) => {
    if (stage.startsWith('run release:pack --family dsh')) await pack.promise
    if (stage.startsWith('run prepare:runtime')) await runtime.promise
  })
  const outcome = packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--prepare-only'], 'darwin', 'arm64'), environment, run)
    .then(() => undefined, (error: unknown) => error)
  const settled = vi.fn()
  void outcome.then(settled)
  try {
    await vi.waitFor(() => expect(run.run.mock.calls.map(([stage]) => stage)).toContain('run prepare:runtime --defer-primary-runtime-smoke'))
    pack.reject(new Error('pack failed'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
  } finally {
    pack.resolve()
    runtime.resolve()
    await outcome
  }
  expect(await outcome).toMatchObject({ errors: [new Error('pack failed')] })
  expect(run.run.mock.calls.map(([stage]) => stage)).not.toContain('run prepare:packages')
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([
  ['mac-arm64', false], ['mac-arm64', true], ['mac-x64', false], ['mac-x64', true],
] as const)('builds unsigned %s with directory=%s without Apple credentials, notarization, or a release record', async (target, directory) => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation([target, '--unsigned', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, CSC_LINK: 'unused.p12', CSC_KEY_PASSWORD: 'unused-secret', APPLE_API_KEY: 'unused.p8',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Unused identity', DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  }, run)
  expect(stages.at(-2)).toBe(`exec electron-builder --config electron-builder.config.mjs --mac --${target === 'mac-arm64' ? 'arm64' : 'x64'} --publish never${directory ? ' --dir' : ''}`)
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  for (const call of run.run.mock.calls) {
    expect(call[3].env).toMatchObject({ DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY', 'DSH_DESKTOP_MACOS_TEAM_ID']) {
      expect(call[3].env).not.toHaveProperty(key)
    }
  }
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('fails unsigned macOS packaging when the assembled runtime cannot run', async () => {
  const { run, stages } = supervisor('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--unsigned'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --unsigned')
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([false, true])('refuses macOS release records after an assembled-runtime failure (directory=%s)', async (directory) => {
  const { run } = supervisor('exec tsx scripts/smoke-packaged-runtime.ts')
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(withMacOSNotarizationProxy).toHaveBeenCalledTimes(directory ? 0 : 1)
  expect(packageMacOSArtifacts).toHaveBeenCalledTimes(directory ? 0 : 1)
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('checks macOS directory packages without writing a release record', async () => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--dir'], 'darwin', 'arm64'), { ...environment, APPLE_KEYCHAIN_PROFILE: 'fixture' }, run)
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts')
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([undefined, '2'])('passes macOS pack concurrency %s only to workspace packing and download routing only to download stages', async (concurrency) => {
  const { run } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--prepare-only'], 'darwin', 'arm64'), {
    ...environment, DSH_DESKTOP_MACOS_PACK_CONCURRENCY: concurrency,
    DSH_DESKTOP_MACOS_DOWNLOAD_PROXY: 'http://downloads.example:8080',
    DSH_DESKTOP_MACOS_NOTARIZATION_PROXY: 'http://apple.example:8081',
  }, run)
  const calls = run.run.mock.calls
  const packs = calls.filter(call => call[0].startsWith('run release:pack'))
  expect(packs).toHaveLength(2)
  for (const call of packs) expect(call[2].slice(-2)).toEqual(['--concurrency', concurrency ?? '4'])
  for (const call of calls) {
    expect(call[3].env.HTTP_PROXY).toBe(/^run prepare:(?:runtime --defer-primary-runtime-smoke|dsh)$/u.test(call[0]) ? 'http://downloads.example:8080' : undefined)
  }
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
})

it.each([false, true])('scopes the Apple proxy around notarization (directory=%s)', async (directory) => {
  const { run } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, APPLE_KEYCHAIN_PROFILE: 'fixture', DSH_DESKTOP_MACOS_NOTARIZATION_PROXY: 'http://apple.example:8081',
  }, run)
  expect(withMacOSNotarizationProxy).toHaveBeenCalledExactlyOnceWith('http://apple.example:8081', expect.any(Function), undefined, undefined, expect.any(Function))
  expect(packageMacOSArtifacts).toHaveBeenCalledTimes(directory ? 0 : 1)
  if (!directory) {
    const signing = run.run.mock.calls.findIndex(call => call[0].includes('--config.mac.notarize=false'))
    expect(signing).toBeGreaterThan(-1)
    expect(run.run.mock.invocationCallOrder[signing]).toBeLessThan(vi.mocked(withMacOSNotarizationProxy).mock.invocationCallOrder[0]!)
  }
  const smoke = run.run.mock.calls.findIndex(call => call[0].includes('smoke-packaged-runtime'))
  expect(smoke).toBeGreaterThan(-1)
  expect(run.run.mock.invocationCallOrder[smoke]).toBeLessThan(vi.mocked(withMacOSNotarizationProxy).mock.invocationCallOrder[0]!)
})

it('does not write a release completion record when Apple proxy cleanup fails', async () => {
  const { run } = supervisor()
  vi.mocked(withMacOSNotarizationProxy).mockRejectedValueOnce(new Error('proxy restoration failed'))
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('proxy restoration failed')
  expect(writeFileSync).not.toHaveBeenCalled()
})

it.each([false, true])('keeps signing and runtime verification when notarization is skipped (directory=%s)', async (directory) => {
  const { run, stages } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--skip-notarization', ...(directory ? ['--dir'] : [])], 'darwin', 'arm64'), {
    ...environment, CSC_LINK: 'signing.p12', CSC_KEY_PASSWORD: 'fixture-password',
  }, run)
  expect(stages.at(-2)).toBe(`exec electron-builder --config electron-builder.config.mjs --mac --arm64 --publish never${directory ? ' --dir' : ''}`)
  expect(stages.at(-1)).toBe('exec tsx scripts/smoke-packaged-runtime.ts --skip-notarization')
  expect(run.run.mock.calls.at(-2)![3].env).toMatchObject({
    DSH_DESKTOP_UNSIGNED: '0', DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '1', CSC_LINK: 'signing.p12',
  })
  expect(withMacOSNotarizationProxy).not.toHaveBeenCalled()
  expect(packageMacOSArtifacts).not.toHaveBeenCalled()
  expect(writeFileSync).not.toHaveBeenCalled()
})

it('strips upload-only COS credentials from signed packaging subprocesses', async () => {
  const { run } = supervisor()
  await packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--prepare-only'], 'darwin', 'arm64'), {
    ...environment,
    CSC_LINK: 'signing.p12',
    CSC_KEY_PASSWORD: 'fixture-password',
    DOWNLOAD_TEST_COS_SECRET_ID: 'synthetic-test-id',
    DOWNLOAD_TEST_COS_SECRET_KEY: 'synthetic-test-key',
    DOWNLOAD_PROD_COS_SECRET_ID: 'synthetic-prod-id',
    DOWNLOAD_PROD_COS_SECRET_KEY: 'synthetic-prod-key',
  }, run)
  expect(run.run).toHaveBeenCalled()
  for (const call of run.run.mock.calls) {
    for (const key of ['DOWNLOAD_TEST_COS_SECRET_ID', 'DOWNLOAD_TEST_COS_SECRET_KEY', 'DOWNLOAD_PROD_COS_SECRET_ID', 'DOWNLOAD_PROD_COS_SECRET_KEY']) {
      expect(call[3].env).not.toHaveProperty(key)
    }
  }
})

it('fails debugging packages when runtime verification fails', async () => {
  const failure = 'exec tsx scripts/smoke-packaged-runtime.ts --skip-notarization'
  const { run, stages } = supervisor(failure)
  await expect(packageTarget(parseDesktopPackageInvocation(['mac-arm64', '--skip-notarization'], 'darwin', 'arm64'), environment, run))
    .rejects.toThrow('stage refused')
  expect(stages.at(-1)).toBe(failure)
  expect(writeFileSync).not.toHaveBeenCalled()
})
