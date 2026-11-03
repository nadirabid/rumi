/** Publish verified Apple Silicon artifacts as one GitHub release, exposing its feed only after all uploads finish. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dump, load } from 'js-yaml'
import { valid } from 'semver'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { resolveDesktopAutoUpdateConfig, desktopUpdateMetadataFilename } from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { verifyMacOSDiskImage, verifyMacOSNotarizedApplication } from './verify-macos-signature.mjs'

async function digest(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function main() {
  const { values } = parseArgs({ options: { publish: { type: 'boolean', default: false } } })
  const env = loadDesktopPackageEnvironment('darwin')
  const update = resolveDesktopAutoUpdateConfig(env, 'darwin', 'arm64')
  const repository = env.RUMI_RELEASE_REPOSITORY
  if (!repository) throw new Error('Rumi publishing requires RUMI_RELEASE_REPOSITORY')
  const root = desktopTargetBuildPaths('mac-arm64').artifacts
  const record = JSON.parse(await readFile(join(root, 'mac-arm64-release.json'), 'utf8'))
  if (record.schemaVersion !== 1 || record.target !== 'mac-arm64' || record.environment !== 'production'
    || record.publicUrl !== update.publicUrl || record.channel !== update.channel || !valid(record.version)) {
    throw new Error('Rumi release record does not match this publishing destination')
  }
  const version = record.version
  const tag = `rumi-v${version}`
  const base = `rumi-${version}-mac-arm64`
  const binaries = [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`]
  for (const name of binaries) {
    if ((await stat(join(root, name))).size === 0) throw new Error(`Empty release artifact: ${name}`)
  }
  const metadataName = desktopUpdateMetadataFilename(version, 'darwin', update.channel)
  const metadata = load(await readFile(join(root, metadataName), 'utf8'))
  if (!metadata || typeof metadata !== 'object' || metadata.version !== version || !Array.isArray(metadata.files)
    || metadata.files.length !== 1 || metadata.files[0].url !== `${base}.zip`) {
    throw new Error('Rumi ZIP update metadata does not match the completed release')
  }
  const zip = join(root, `${base}.zip`)
  const sha512 = await digest(zip)
  if (metadata.files[0].sha512 !== sha512 || metadata.sha512 !== sha512
    || metadata.files[0].size !== (await stat(zip)).size) throw new Error('Rumi ZIP checksum or size mismatch')
  const expected = resolveMacOSSigningEnvironment(env)
  verifyMacOSNotarizedApplication(join(root, 'mac-arm64', 'Rumi.app'), expected)
  verifyMacOSDiskImage(join(root, `${base}.dmg`), expected)
  const repo = JSON.parse(execFileSync('gh', ['repo', 'view', repository, '--json', 'isPrivate'], { encoding: 'utf8' }))
  if (repo.isPrivate) throw new Error('Rumi update downloads require a public repository')
  const download = `https://github.com/${repository}/releases/download/${tag}/`
  metadata.files[0].url = `${download}${base}.zip`
  metadata.path = metadata.files[0].url
  console.log(`Verified ${tag} for ${repository}; ${values.publish ? 'publishing' : 'pass --publish to publish'}`)
  if (!values.publish) return
  const temporary = await mkdtemp(join(tmpdir(), 'rumi-release-'))
  try {
    const feed = join(temporary, metadataName)
    const notes = join(temporary, 'notes.md')
    await writeFile(feed, dump(metadata))
    await writeFile(notes, `Rumi for Apple Silicon Macs. Download the DMG, open it, and drag Rumi to Applications.\n\nSigned with Developer ID and notarized by Apple. Existing installations can use Check for Updates in Rumi.\n\nBuild: ${version}. Source commit: ${record.commit ?? 'unrecorded'}${record.dirty ? ' (includes local changes)' : ''}.\n`)
    execFileSync('gh', ['release', 'create', tag, '--repo', repository, '--draft', '--title', `Rumi ${version}`,
      '--notes-file', notes, ...binaries.map(name => join(root, name)), feed], { stdio: 'inherit' })
    execFileSync('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'], { stdio: 'inherit' })
    console.log(`Published https://github.com/${repository}/releases/tag/${tag}`)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) await main()
