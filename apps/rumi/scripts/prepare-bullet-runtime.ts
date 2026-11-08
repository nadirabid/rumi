/** Build and package the pinned Bullet mechanism checker without end-user build tools. */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { desktopTargetPlatform, type resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import lock from './bullet-runtime.lock.json' with { type: 'json' }

type Target = ReturnType<typeof resolveDesktopBuildTarget>
type BuildPlatform = 'darwin' | 'win32'

function buildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
}

function assertIdentity(output: string, selfTest: boolean): void {
  const identity: unknown = JSON.parse(output)
  if (typeof identity !== 'object' || identity === null
    || !('protocolVersion' in identity) || identity.protocolVersion !== lock.protocolVersion
    || !('bulletVersion' in identity) || identity.bulletVersion !== lock.bulletVersion
    || !('precision' in identity) || identity.precision !== 'double'
    || (selfTest && (!('ok' in identity) || identity.ok !== true))) {
    throw new Error('Bundled Bullet identity or geometric self-test does not match the release lock')
  }
}

/**
 * Resolve build-host and target flags before downloading sources or allocating a build directory.
 * @param target Application architecture being packaged.
 * @param hostPlatform Operating system providing the compiler.
 * @param minimumMacOSVersion Minimum macOS version declared by the packaged Electron; required for macOS targets.
 * @param sdkRoot Explicit macOS SDKROOT, if configured; omission uses the compiler's selected SDK.
 * @returns Build-tool platform, executable name, and CMake target arguments.
 */
export function bulletBuildTarget(
  target: Target, hostPlatform: NodeJS.Platform, minimumMacOSVersion: string | undefined, sdkRoot?: string,
): {
  platform: BuildPlatform
  executable: string
  arguments: string[]
} {
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== hostPlatform) throw new Error('Bullet packaging requires a build host matching the target operating system')
  if (platform.platform === 'win32') {
    return { platform: 'win32', executable: 'rumi-bullet.exe', arguments: ['-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'] }
  }
  if (minimumMacOSVersion === undefined || !/^\d+\.\d+(?:\.\d+)?$/u.test(minimumMacOSVersion)) {
    throw new Error('Bullet packaging requires the packaged Electron minimum macOS version')
  }
  return { platform: 'darwin', executable: 'rumi-bullet', arguments: [
    `-DCMAKE_OSX_ARCHITECTURES=${platform.arch === 'x64' ? 'x86_64' : 'arm64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minimumMacOSVersion}`,
    ...(sdkRoot === undefined ? [] : [`-DCMAKE_OSX_SYSROOT=${sdkRoot}`]),
  ] }
}

/**
 * Compile a static double-precision helper from checksum-verified inputs and publish it atomically.
 * @param target Architecture of the application being packaged.
 * @param runtime Build-owned runtime directory; runtime/bullet must be absent.
 * @param cache Checksum-addressed download cache shared by packaging stages.
 * @param minimumMacOSVersion Minimum macOS version declared by the packaged Electron; undefined for Windows.
 * @returns Resolves after compilation, license staging and native-host geometric smoke checks; failure publishes no helper.
 */
export async function prepareBulletRuntime(
  target: Target, runtime: string, cache: string, minimumMacOSVersion: string | undefined,
): Promise<void> {
  const build = bulletBuildTarget(target, process.platform, minimumMacOSVersion, process.env.SDKROOT)
  const destination = join(runtime, 'bullet')
  if (existsSync(destination)) throw new Error('Bullet runtime destination already exists; prepare a fresh runtime directory')
  const tool = lock.cmake[build.platform]
  const [archive, header, license, cmakeArchive] = await Promise.all([
    downloadPrimaryRuntimeAsset(lock.source.url, lock.source.sha256, cache),
    downloadPrimaryRuntimeAsset(lock.json.header.url, lock.json.header.sha256, cache),
    downloadPrimaryRuntimeAsset(lock.json.license.url, lock.json.license.sha256, cache),
    downloadPrimaryRuntimeAsset(tool.url, tool.sha256, cache),
  ])
  mkdirSync(runtime, { recursive: true })
  const work = mkdtempSync(join(runtime, '.bullet-build-'))
  const payload = join(work, 'payload')
  try {
    const source = join(work, 'source'), include = join(work, 'include')
    mkdirSync(source)
    mkdirSync(join(include, 'nlohmann'), { recursive: true })
    await extractTar({ file: archive, cwd: source, strip: 1, filter: (path) => {
      const components = path.replace(/\/$/u, '').split('/')
      return components.length <= 2 || components[1] === 'src'
    } })
    cpSync(header, join(include, 'nlohmann', 'json.hpp'))
    const tools = join(work, 'tools')
    await extractZip(cmakeArchive, { dir: tools })
    const cmake = join(tools, 'cmake', 'data', 'bin', build.platform === 'win32' ? 'cmake.exe' : 'cmake')
    if (build.platform === 'darwin') chmodSync(cmake, 0o755)
    const output = join(work, 'build')
    const options = { encoding: 'utf8' as const, env: buildEnvironment(), timeout: 900_000, maxBuffer: 32 * 1024 * 1024 }
    execFileSync(cmake, ['-S', join(import.meta.dirname, '..', 'brand', 'print-studio', 'bullet'), '-B', output,
      `-DBULLET_SOURCE_DIR=${source}`, `-DNLOHMANN_INCLUDE_DIR=${include}`, '-DCMAKE_BUILD_TYPE=Release',
      ...build.arguments], options)
    execFileSync(cmake, ['--build', output, '--config', 'Release', '--target', 'rumi-bullet', '--parallel', '4'], options)
    mkdirSync(join(payload, 'bin'), { recursive: true })
    mkdirSync(join(payload, 'licenses'))
    cpSync(join(output, 'bin', build.executable), join(payload, 'bin', build.executable))
    if (build.platform === 'darwin') chmodSync(join(payload, 'bin', build.executable), 0o755)
    cpSync(join(source, 'LICENSE.txt'), join(payload, 'licenses', 'Bullet-LICENSE.txt'))
    cpSync(license, join(payload, 'licenses', 'nlohmann-json-LICENSE.MIT'))
    writeFileSync(join(payload, 'runtime.json'), `${JSON.stringify({
      schemaVersion: 1, target, minimumMacOSVersion, protocolVersion: lock.protocolVersion, bulletVersion: lock.bulletVersion,
      precision: 'double', source: lock.source, json: lock.json, cmake: { version: lock.cmake.version, ...tool },
    }, null, 2)}\n`)
    writeFileSync(join(payload, 'README.txt'), `Rumi Bullet mechanism checker\nBullet ${lock.version}, commit ${lock.source.commit}, statically linked with double precision.\nnlohmann/json ${lock.json.version}. License notices are in licenses/.\nSources: ${lock.source.url}\nJSON: ${lock.json.header.url}\nNo separate Bullet installation, Python environment or compiler is required to run this helper.\n`)
    checkBulletPayload(payload, target)
    renameSync(payload, destination)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function checkBulletPayload(root: string, target: Target): void {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('target' in manifest) || manifest.target !== target
    || !('schemaVersion' in manifest) || manifest.schemaVersion !== 1
    || !('source' in manifest) || JSON.stringify(manifest.source) !== JSON.stringify(lock.source)
    || !('json' in manifest) || JSON.stringify(manifest.json) !== JSON.stringify(lock.json)) {
    throw new Error('Packaged Bullet manifest does not match the application target')
  }
  assertIdentity(JSON.stringify(manifest), false)
  const executable = join(root, 'bin', target === 'win-x64' ? 'rumi-bullet.exe' : 'rumi-bullet')
  for (const path of [executable, join(root, 'licenses', 'Bullet-LICENSE.txt'), join(root, 'licenses', 'nlohmann-json-LICENSE.MIT'), join(root, 'README.txt')]) {
    if (!existsSync(path)) throw new Error(`Packaged Bullet resource is missing: ${path}`)
  }
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== process.platform || platform.arch !== process.arch) return
  const options = { encoding: 'utf8' as const, env: buildEnvironment(), timeout: 30_000, maxBuffer: 1024 * 1024 }
  assertIdentity(execFileSync(executable, ['--version'], options), false)
  assertIdentity(execFileSync(executable, ['--self-test'], options), true)
}

/**
 * Verify the final application's native helper and run its geometric self-test on matching hosts.
 * @param resources Application Resources directory containing runtime/bullet.
 * @param target Packaged architecture; foreign targets receive manifest and presence checks only.
 */
export function smokeBulletRuntime(resources: string, target: Target): void {
  const root = join(resources, 'runtime', 'bullet')
  checkBulletPayload(root, target)
  if (process.platform === 'darwin' && target !== 'win-x64') {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', join(root, 'bin', 'rumi-bullet')], { env: buildEnvironment(), stdio: 'pipe' })
  }
}
