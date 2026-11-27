import { describe, expect, it, vi } from 'vitest'

const { verifyDesktopRuntime, scopeMacOSExecutableIdentities } = vi.hoisted(() => ({
  verifyDesktopRuntime: vi.fn<(root: string, expected: string) => Promise<void>>(async () => undefined),
  scopeMacOSExecutableIdentities: vi.fn(async () => undefined),
}))
vi.mock('../lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime }))
vi.mock('../scripts/macos-executable-identity.mjs', () => ({ scopeMacOSExecutableIdentities }))

const ENVIRONMENT = {
  DSH_DESKTOP_APP_ID: 'com.nadirmuzaffar.rumi',
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_UNSIGNED: '1',
}

const CONTEXT = {
  appOutDir: 'out',
  packager: { getResourcesDir: () => 'out/Rumi.app/Contents/Resources', appInfo: { productFilename: 'Rumi', updaterCacheDirName: 'rumi-updater' } },
}

async function requiredRuntimeVersion(preparedRuntime?: string, preparedRuntimeVersion?: string): Promise<unknown> {
  verifyDesktopRuntime.mockClear()
  const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
  const config = createElectronBuilderConfig(ENVIRONMENT, 'darwin', 'arm64', preparedRuntime, preparedRuntimeVersion)
  await config.afterPack(CONTEXT as never)
  return verifyDesktopRuntime.mock.calls[0]?.[1]
}

describe('packaged runtime verification', () => {
  it('requires the product version when the target tree supplies the runtime', async () => {
    const productVersion = (JSON.parse(
      await import('node:fs/promises').then(async fs => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string }).version
    expect(await requiredRuntimeVersion()).toBe(productVersion)
  })

  it('accepts an explicit prepared runtime version override', async () => {
    expect(await requiredRuntimeVersion('/custom/dsh', '0.1.6-alpha.2.20260921.1')).toBe('0.1.6-alpha.2.20260921.1')
  })

  it('does not let a build version change what the bundled runtime must declare', async () => {
    const productVersion = (JSON.parse(
      await import('node:fs/promises').then(async fs => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string }).version
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    verifyDesktopRuntime.mockClear()
    const config = createElectronBuilderConfig(
      { ...ENVIRONMENT, DSH_DESKTOP_BUILD_VERSION: `${productVersion}.20260921.1` }, 'darwin', 'arm64')
    expect(config.extraMetadata).toMatchObject({ version: `${productVersion}.20260921.1` })
    await config.afterPack(CONTEXT as never)
    expect(verifyDesktopRuntime.mock.calls[0]?.[1]).toBe(productVersion)
  })
})
