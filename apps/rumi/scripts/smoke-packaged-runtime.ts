/** Validate the assembled application, including native Office conversion outside ASAR. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { smokeBlenderRuntime } from './prepare-blender-runtime.ts'
import { smokeBulletRuntime } from './prepare-bullet-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'Rumi.app', 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const executable = windows ? join(application, 'Rumi.exe') : join(application, 'MacOS', 'Rumi')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
smokeBlenderRuntime(resources, target)
smokeBulletRuntime(resources, target)
if (!windows) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(application, '..')], { stdio: 'pipe' })
console.log('Rumi runtime: bundled Blender editing, USD export and Bullet mechanics passed')
