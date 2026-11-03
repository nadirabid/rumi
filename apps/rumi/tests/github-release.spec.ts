/** Hosted release numbering and private configuration consumed by the real packager. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nextReleaseVersion, prepareSigning } from '../scripts/prepare-github-release.mjs'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

it('advances past manual releases, reruns, and a later published date', () => {
  const now = new Date('2026-11-03T00:00:00Z')
  expect(nextReleaseVersion('0.2.1-rc.3', undefined, now)).toBe('0.2.1-rc.3.20261103.1')
  expect(nextReleaseVersion('0.2.1-rc.3', '0.2.1-rc.3.20261103.12', now)).toBe('0.2.1-rc.3.20261103.13')
  expect(nextReleaseVersion('0.2.1-rc.3', '0.2.1-rc.3.20261104.2.3', now)).toBe('0.2.1-rc.3.20261104.3')
  expect(() => nextReleaseVersion('0.2.1-rc.3', '0.3.0', now)).toThrow('cannot advance')
})

it('writes private signing settings that the production packager can read', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'rumi-release-test-'))
  try {
    const root = await prepareSigning({
      RUNNER_TEMP: temporary, GITHUB_REPOSITORY: 'example/rumi',
      RUMI_CERTIFICATE_BASE64: Buffer.from('test certificate').toString('base64'),
      RUMI_CERTIFICATE_PASSWORD: 'test-password', RUMI_SIGNING_IDENTITY: 'Developer ID Application: Test',
      RUMI_APPLE_TEAM_ID: 'TEAMTEST', RUMI_APPLE_ID: 'example@example.test', RUMI_APPLE_APP_PASSWORD: 'test-notary',
    })
    const loaded = loadDesktopPackageEnvironment('darwin', { DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: root })
    expect(loaded.RUMI_RELEASE_REPOSITORY).toBe('example/rumi')
    expect(loaded.APPLE_APP_SPECIFIC_PASSWORD).toBe('test-notary')
    expect(await readFile(loaded.CSC_LINK!, 'utf8')).toBe('test certificate')
    expect((await stat(join(root, 'secrets', 'macos-signing.env'))).mode & 0o777).toBe(0o600)
    expect((await stat(loaded.CSC_LINK!)).mode & 0o777).toBe(0o600)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

it('fails before building when signing inputs are missing', async () => {
  await expect(prepareSigning({})).rejects.toThrow('Missing release setting: RUMI_CERTIFICATE_BASE64')
})
