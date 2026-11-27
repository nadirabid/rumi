/** Validate the assembled application, including bundled modeling and mechanical checks. */
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { smokeBlenderRuntime } from './prepare-blender-runtime.ts'
import { smokeBulletRuntime } from './prepare-bullet-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { application: { type: 'string' }, unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const application = values.application ? resolve(values.application)
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'Rumi.app', 'Contents')
const resources = join(application, 'Resources')
const executable = join(application, 'MacOS', 'Rumi')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
smokeBlenderRuntime(resources, target)
smokeBulletRuntime(resources, target)
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(application, '..')], { stdio: 'pipe' })
console.log('Rumi runtime: bundled Blender editing, USD export and Bullet mechanics passed')
