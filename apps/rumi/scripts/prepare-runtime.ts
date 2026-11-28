/** Prepare Desktop resources and publish their versions after every preparation stage succeeds. */

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import electronChecksums from 'electron/checksums.json' with { type: 'json' }
import extractZip from 'extract-zip'
import { readPrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packagingStep } from './packaging-step.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'
import { prepareCadRuntime } from './prepare-cad-runtime.ts'
import { prepareBulletRuntime } from './prepare-bullet-runtime.ts'
import { prepareDesktopCli } from './prepare-cli.ts'
import { prepareCommandLink } from './prepare-command-link.ts'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime

type DesktopTarget = ReturnType<typeof desktopTargetPlatform>

/** Extract the target Electron distribution and return its embedded Node version. */
async function prepareElectron({ platform, arch }: DesktopTarget): Promise<string> {
  const require = createRequire(import.meta.url)
  const { version } = require('electron/package.json') as { version: string }
  const archive = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'download:electron',
    () => downloadArtifact({
      version, platform, arch, artifactName: 'electron', checksums: electronChecksums, cacheRoot: BUILD_PATHS.downloads,
    }))
  rmSync(BUILD_PATHS.electron, { recursive: true, force: true })
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:electron', () => extractZip(archive, { dir: BUILD_PATHS.electron }))
  const executable = join(BUILD_PATHS.electron, platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
  return execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
}

function minimumMacOSVersion(): string {
  return execFileSync('/usr/libexec/PlistBuddy', [
    '-c', 'Print LSMinimumSystemVersion', join(BUILD_PATHS.electron, 'Electron.app', 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim()
}

function prepareCli({ platform, arch }: DesktopTarget): void {
  cpSync(join(import.meta.dirname, 'node-bin'), join(RUNTIME_ROOT, 'bin'), { recursive: true })
  chmodSync(join(RUNTIME_ROOT, 'bin', 'node'), 0o755)
  const cli = join(RUNTIME_ROOT, 'cli')
  prepareDesktopCli(cli, platform)
  if (platform === 'darwin') {
    prepareCommandLink(cli, arch, minimumMacOSVersion())
  }
  cpSync(join(import.meta.dirname, '..', 'lib', 'command-manager-entry.js'), join(cli, 'command-manager.js'))
}

/**
 * Prepare the target runtimes and publish their versions after all stages succeed.
 * @param deferPrimaryRuntimeSmoke - Leave the execution check to the later full-package preparation stage.
 * @returns Resolves after every payload is ready. A failure drains the other stages before removing the incomplete runtime.
 */
export async function prepareDesktopRuntime(deferPrimaryRuntimeSmoke: boolean): Promise<void> {
  const targetName = resolveDesktopBuildTarget()
  const target = desktopTargetPlatform(targetName)
  const journal = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  rmSync(RUNTIME_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  try {
    const electron = prepareElectron(target)
    const results = await Promise.allSettled([
      packagingStep(journal, 'prepare:primary-runtime', () => preparePrimaryRuntime({ deferSmoke: deferPrimaryRuntimeSmoke })),
      packagingStep(journal, 'prepare:cad', () => prepareCadRuntime(targetName, RUNTIME_ROOT, BUILD_PATHS.downloads)),
      electron.then(() => packagingStep(journal, 'prepare:bullet', () => prepareBulletRuntime(
        targetName, RUNTIME_ROOT, BUILD_PATHS.downloads, target.platform === 'darwin' ? minimumMacOSVersion() : undefined,
      ))),
    ])
    const failures = results.filter(result => result.status === 'rejected').map(({ reason }): unknown => reason)
    if (failures.length > 0) throw new AggregateError(failures, 'desktop runtime: preparation failed')
    const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))
    if (pnpm === undefined) throw new Error('desktop runtime: primary-runtime manifest has no pnpm version')
    await packagingStep(journal, 'prepare:cli', async () => { prepareCli(target) })
    writeFileSync(join(RUNTIME_ROOT, 'versions.json'), `${JSON.stringify({
      schemaVersion: 1,
      node: await electron,
      pnpm,
    }, undefined, 2)}\n`)
  } catch (error) {
    try { rmSync(RUNTIME_ROOT, { recursive: true, force: true }) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'desktop runtime: could not remove incomplete preparation')
    }
    throw error
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  await prepareDesktopRuntime(values['defer-primary-runtime-smoke'])
}
