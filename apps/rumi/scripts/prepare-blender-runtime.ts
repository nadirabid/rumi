/** Package a pinned, independently executable Blender distribution and its source archive. */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'
import lock from './blender-runtime.lock.json' with { type: 'json' }

type Target = keyof typeof lock.targets

/**
 * Stage the verified release into runtime/blender; a failed preparation publishes no payload.
 * @param target - Architecture of the application being packaged.
 * @param runtime - Build-owned runtime directory.
 * @param cache - Shared checksum-addressed download cache.
 * @returns Resolves after archive extraction and native signature/version verification.
 */
export async function prepareBlenderRuntime(target: Target, runtime: string, cache: string): Promise<void> {
  const artifact = lock.targets[target]
  const archive = await downloadPrimaryRuntimeAsset(`https://mirror.blender.org/release/Blender${lock.version.split('.').slice(0, 2).join('.')}/${artifact.filename}`, artifact.sha256, cache)
  const source = await downloadPrimaryRuntimeAsset(lock.source.url, lock.source.sha256, cache)
  mkdirSync(runtime, { recursive: true })
  const stage = mkdtempSync(join(runtime, '.blender-'))
  const destination = join(runtime, 'blender')
  try {
    if (target === 'win-x64') {
      const extracted = join(stage, 'archive')
      await extractZip(archive, { dir: extracted })
      renameSync(join(extracted, artifact.filename.slice(0, -4)), join(stage, 'Blender'))
      rmSync(extracted, { recursive: true })
    } else {
      if (process.platform !== 'darwin') throw new Error('Blender macOS packaging requires a macOS build host')
      const mount = join(stage, 'mount')
      mkdirSync(mount)
      execFileSync('/usr/bin/hdiutil', ['attach', archive, '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'pipe' })
      try {
        cpSync(join(mount, 'Blender.app'), join(stage, 'Blender.app'), { recursive: true, verbatimSymlinks: true })
      } finally {
        execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' })
      }
      rmSync(mount, { recursive: true })
      cpSync(new URL('./blender-launcher.sh', import.meta.url), join(stage, 'blender'))
      chmodSync(join(stage, 'blender'), 0o755)
      // Preserve Blender Foundation signatures instead of rewriting this independent application.
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(stage, 'Blender.app')], { stdio: 'pipe' })
    }
    cpSync(source, join(stage, `blender-${lock.version}.tar.xz`))
    writeFileSync(join(stage, 'README.txt'), `Blender ${lock.version}\nIndependent Blender Foundation application, distributed under GNU GPL.\nOriginal license notices are retained inside the distribution.\nCorresponding Blender source archive: blender-${lock.version}.tar.xz\nSource: ${lock.source.url}\nLicense: https://www.blender.org/about/license/\nBinary SHA-256: ${artifact.sha256}\nSource SHA-256: ${lock.source.sha256}\n`)
    writeFileSync(join(stage, 'runtime.json'), `${JSON.stringify({ version: lock.version, target, binary: artifact, source: lock.source }, null, 2)}\n`)
    const platform = desktopTargetPlatform(target)
    if (platform.platform === process.platform && platform.arch === process.arch) {
      const executable = join(stage, target === 'win-x64' ? 'Blender/blender.exe' : 'blender')
      const version = execFileSync(executable, ['--background', '--factory-startup', '--version'], { encoding: 'utf8', timeout: 60_000 })
      if (!version.startsWith(`Blender ${lock.version}`)) throw new Error('Bundled Blender version does not match the release lock')
    }
    if (existsSync(destination)) throw new Error('Blender runtime destination already exists; prepare a fresh runtime directory')
    renameSync(stage, destination)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * Exercise the final packaged Blender and helper without a separate install or user startup file.
 * @param resources - Application Resources directory containing runtime and the unpacked helper.
 * @param target - Packaged application architecture; foreign payloads receive presence checks only.
 * @returns Resolves after Blender publishes a cube and reopens its editable original.
 */
export function smokeBlenderRuntime(resources: string, target: Target): void {
  const root = join(resources, 'runtime', 'blender')
  const manifest = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { version: string; target: string }
  if (manifest.version !== lock.version || manifest.target !== target) throw new Error('Packaged Blender manifest does not match the release lock')
  const executable = join(root, target === 'win-x64' ? 'Blender/blender.exe' : 'blender')
  const helper = join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@rumi', 'print-studio', 'blender', 'rumi_blender.py')
  for (const path of [executable, helper, join(root, `blender-${lock.version}.tar.xz`), join(root, 'README.txt')]) {
    if (!existsSync(path)) throw new Error(`Packaged Blender resource is missing: ${path}`)
  }
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== process.platform || platform.arch !== process.arch) return
  const python = [
    'import bpy, runpy, tempfile, pathlib',
    `helper = runpy.run_path(${JSON.stringify(helper)})`,
    'bpy.ops.object.select_all(action="SELECT")',
    'bpy.ops.object.delete(use_global=False)',
    'bpy.ops.mesh.primitive_cube_add(size=0.04)',
    'with tempfile.TemporaryDirectory(prefix="rumi-blender-smoke-") as directory:',
    '    report = helper["publish"](directory)',
    '    assert report["triangles"] == 12, report',
    '    assert all(abs(v - 40) < 0.001 for v in report["dimensionsMm"].values()), report',
    '    assert pathlib.Path(report["preview"]).read_bytes()[:4] == b"glTF"',
    '    bpy.ops.wm.open_mainfile(filepath=report["blend"])',
    '    assert len([o for o in bpy.context.scene.objects if o.type == "MESH"]) == 1',
    'print("RUMI_BUNDLED_BLENDER_OK")',
  ].join('\n')
  const output = execFileSync(executable, ['--background', '--factory-startup', '--python-exit-code', '1', '--python-expr', python], { encoding: 'utf8', timeout: 60_000 })
  if (!output.includes('RUMI_BUNDLED_BLENDER_OK')) throw new Error('Packaged Blender smoke did not complete')
  if (platform.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(root, 'Blender.app')], { stdio: 'pipe' })
  }
  // Loading the helper must not mutate the signed application with Python bytecode.
  if (readdirSync(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@rumi', 'print-studio', 'blender')).includes('__pycache__')) {
    throw new Error('Packaged Blender helper wrote bytecode into the application')
  }
}
