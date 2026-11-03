/** Prepare private signing inputs and monotonically numbered Rumi releases on hosted runners. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { gt, valid } from 'semver'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'

/**
 * Choose a build newer than the published feed, including prior manual releases.
 * @param {string} product Product version in the checkout.
 * @param {string | undefined} latest Latest published Rumi version.
 * @param {Date} now Build date.
 * @returns {string} Monotonically increasing update version.
 */
export function nextReleaseVersion(product, latest, now) {
  const prefix = desktopBuildVersionPrefix(product)
  let date = now.toISOString().slice(0, 10).replaceAll('-', '')
  let sequence = 1
  if (latest !== undefined) {
    if (!valid(latest)) throw new Error('Published Rumi version is invalid')
    if (latest.startsWith(prefix)) {
      const suffix = latest.slice(prefix.length).split('.')
      if (!/^\d{8}$/u.test(suffix[0]) || !/^\d+$/u.test(suffix[1] ?? '')) throw new Error('Published Rumi build suffix is invalid')
      if (suffix[0] >= date) { date = suffix[0]; sequence = Number(suffix[1]) + 1 }
    }
  }
  if (!Number.isSafeInteger(sequence)) throw new Error('Rumi release sequence is exhausted')
  const candidate = validateDesktopBuildVersion(`${prefix}${date}.${sequence}`, product)
  if (latest && !gt(candidate, latest)) throw new Error('Checkout version cannot advance the published Rumi release')
  return candidate
}

/**
 * Write signing material outside the checkout without logging secret values.
 * @param {NodeJS.ProcessEnv} env GitHub secret inputs and temporary directory.
 * @returns {Promise<string>} Private packaging configuration directory.
 */
export async function prepareSigning(env) {
  const names = ['RUMI_CERTIFICATE_BASE64', 'RUMI_CERTIFICATE_PASSWORD', 'RUMI_SIGNING_IDENTITY', 'RUMI_APPLE_TEAM_ID', 'RUMI_APPLE_ID', 'RUMI_APPLE_APP_PASSWORD', 'RUNNER_TEMP', 'GITHUB_REPOSITORY']
  for (const name of names) if (!env[name]) throw new Error(`Missing release setting: ${name}`)
  if (!/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY)) throw new Error('Invalid release repository')
  const root = join(env.RUNNER_TEMP, 'rumi-release')
  await mkdir(join(root, 'presets'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'secrets'), { recursive: true, mode: 0o700 })
  const encoded = env.RUMI_CERTIFICATE_BASE64.replace(/\s/gu, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('Invalid certificate encoding')
  const certificate = Buffer.from(encoded, 'base64')
  if (certificate.toString('base64') !== encoded) throw new Error('Invalid certificate encoding')
  const certificatePath = join(root, 'secrets', 'developer-id.p12')
  await writeFile(certificatePath, certificate, { mode: 0o600 })
  const settings = {
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: env.RUMI_SIGNING_IDENTITY,
    DSH_DESKTOP_MACOS_TEAM_ID: env.RUMI_APPLE_TEAM_ID,
    CSC_LINK: certificatePath,
    CSC_KEY_PASSWORD: env.RUMI_CERTIFICATE_PASSWORD,
    APPLE_ID: env.RUMI_APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD: env.RUMI_APPLE_APP_PASSWORD,
    APPLE_TEAM_ID: env.RUMI_APPLE_TEAM_ID,
  }
  const encode = (values) => Object.entries(values).map(([key, value]) => {
    if (/[\r\n']/u.test(value)) throw new Error(`Unsupported characters in release setting: ${key}`)
    return `${key}='${value}'\n`
  }).join('')
  const secretText = encode(settings)
  if (Object.entries(settings).some(([key, value]) => parseEnv(secretText)[key] !== value)) throw new Error('Signing settings did not round trip')
  await writeFile(join(root, 'secrets', 'macos-signing.env'), secretText, { mode: 0o600 })
  await writeFile(join(root, 'presets', 'production.env'), encode({
    DSH_DESKTOP_APP_ID: 'com.nadirmuzaffar.rumi',
    DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
    DSH_DESKTOP_MACOS_PACK_CONCURRENCY: '2',
    RUMI_RELEASE_REPOSITORY: env.GITHUB_REPOSITORY,
  }), { mode: 0o600 })
  return root
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const product = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  const latest = process.env.RUMI_LATEST_TAG?.replace(/^rumi-v/u, '') || undefined
  const version = nextReleaseVersion(product, latest, new Date())
  const root = await prepareSigning(process.env)
  await writeFile(process.env.GITHUB_OUTPUT, `version=${version}\nconfig=${root}\n`, { flag: 'a' })
}
