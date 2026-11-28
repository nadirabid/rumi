/** Package a pinned, relocatable Python 3.12 + build123d CAD runtime without user Python leaks. */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'
import lock from './cad-runtime.lock.json' with { type: 'json' }

type Target = keyof typeof lock.targets

interface LockedWheel {
  readonly name: string
  readonly version: string
  readonly url: string
  readonly sha256: string
}

interface CadRuntimeManifest {
  readonly schemaVersion: 1
  readonly target: Target
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly python: string
  readonly pythonRelease: string
  readonly build123d: string
  readonly pythonPackages: Readonly<Record<string, string>>
}

const DOWNLOAD_CONCURRENCY = 8

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key)),
  )
}

function pythonMinorVersion(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

function targetWheels(target: Target): readonly LockedWheel[] {
  return [...lock.targets[target].wheels, ...lock.wheels]
}

function targetPackageVersions(target: Target): Record<string, string> {
  return Object.fromEntries(
    targetWheels(target)
      .map(wheel => [wheel.name, wheel.version] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

async function downloadAllWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index]!) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(runners)
  const failures = results
    .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    .map(entry => entry.reason as unknown)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'CAD runtime: asset download failed')
  return results.map(entry => (entry as PromiseFulfilledResult<R>).value)
}

function hasPycache(directory: string): boolean {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === '__pycache__') return true
  }
  return false
}

function removePycache(directory: string): void {
  const dirs: string[] = []
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === '__pycache__') {
      dirs.push(join(entry.parentPath, entry.name))
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

async function unpackCadWheel(archive: string, pythonRoot: string, sitePackages: string): Promise<void> {
  await extractZip(archive, {
    dir: sitePackages,
    onEntry: (entry) => {
      const [directory, scheme] = entry.fileName.split('/')
      if (directory?.endsWith('.data') && scheme !== '' && !['scripts', 'purelib', 'platlib', 'data'].includes(scheme ?? '')) {
        throw new Error(`CAD runtime: wheel requires unsupported installation paths: ${entry.fileName}`)
      }
    },
  })
  // Merge PEP 427 .data/purelib, .data/platlib, and .data/data payloads into their target directories.
  for (const entry of readdirSync(sitePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.data')) continue
    const dataRoot = join(sitePackages, entry.name)
    for (const [scheme, targetDir] of [['purelib', sitePackages], ['platlib', sitePackages], ['data', pythonRoot]] as const) {
      const source = join(dataRoot, scheme)
      if (!existsSync(source)) continue
      cpSync(source, targetDir, { recursive: true })
      rmSync(source, { recursive: true, force: true })
    }
    if (readdirSync(dataRoot).length === 0) rmSync(dataRoot, { recursive: true, force: true })
  }
}

function copyPythonTree(source: string, destination: string, target: Target): void {
  const minor = pythonMinorVersion(lock.pythonVersion)
  const interpreter = `python${minor}`
  const aliasPaths = target === 'win-x64'
    ? new Set<string>()
    : new Set([join(source, 'bin', 'python'), join(source, 'bin', 'python3')])
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => !aliasPaths.has(path),
  })
  if (target !== 'win-x64') {
    for (const name of ['python', 'python3']) {
      symlinkSync(interpreter, join(destination, 'bin', name))
    }
  }
}

function windowsLauncherScript(): string {
  return [
    '@echo off',
    'setlocal',
    'set "PYTHONHOME="',
    'set "PYTHONPATH="',
    'set "PYTHONUSERBASE="',
    'set "PYTHONSTARTUP="',
    'set "PYTHONINSPECT="',
    'set "PYTHONOPTIMIZE="',
    'set "VIRTUAL_ENV="',
    'set "CONDA_PREFIX="',
    'set "PYTHONDONTWRITEBYTECODE=1"',
    'set "PYTHONNOUSERSITE=1"',
    'set "RUNTIME_DIR=%~dp0"',
    'set "PYTHONHOME=%RUNTIME_DIR%python"',
    'set "PYTHONPATH=%RUNTIME_DIR%python\\Lib\\site-packages"',
    '"%RUNTIME_DIR%python\\python.exe" -s -B %*',
    '',
  ].join('\r\n')
}

/**
 * Identify validated relative Python interpreter aliases inside runtime/cad for signing and verification.
 * @param root - Staged or packaged runtime/cad directory.
 * @returns Relative alias paths mapped to their sibling interpreter filename; empty on Windows.
 */
export function cadRuntimePythonAliases(root: string): ReadonlyMap<string, string> {
  const manifest = readCadRuntimeManifest(root)
  const aliases = new Map<string, string>()
  if (manifest.platform === 'win32') return aliases
  const interpreter = `python${pythonMinorVersion(manifest.python)}`
  for (const name of ['python', 'python3']) {
    const rel = `python/bin/${name}`
    const full = join(root, rel)
    if (!existsSync(full)) continue
    const stat = lstatSync(full)
    if (!stat.isSymbolicLink()) continue
    const linkTarget = readlinkSync(full)
    if (linkTarget !== interpreter || !lstatSync(join(root, 'python/bin', interpreter)).isFile()) {
      throw new Error(`CAD runtime: invalid Python alias ${rel}`)
    }
    aliases.set(rel, interpreter)
  }
  return aliases
}

function isTarget(value: string): value is Target {
  return Object.hasOwn(lock.targets, value)
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string')
}

function readCadRuntimeManifest(root: string): CadRuntimeManifest {
  const parsed: unknown = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CAD runtime: runtime.json is not an object')
  }
  const { schemaVersion, target, platform, arch, python, pythonRelease, build123d, pythonPackages } = parsed as Record<string, unknown>
  if (schemaVersion !== 1
    || typeof target !== 'string' || !isTarget(target)
    || (platform !== 'darwin' && platform !== 'win32')
    || (arch !== 'arm64' && arch !== 'x64')
    || typeof python !== 'string'
    || typeof pythonRelease !== 'string'
    || typeof build123d !== 'string'
    || !isStringRecord(pythonPackages)) {
    throw new Error('CAD runtime: runtime.json has invalid metadata')
  }
  return { schemaVersion, target, platform, arch, python, pythonRelease, build123d, pythonPackages }
}

function runCadRuntimeSelfCheck(root: string, target: Target): void {
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== process.platform || platform.arch !== process.arch) return
  const executable = join(root, target === 'win-x64' ? 'cad-python.cmd' : 'cad-python')
  const checkScript = [
    'import importlib.metadata, site, sys',
    `assert sys.version.split()[0] == ${JSON.stringify(lock.pythonVersion)}, sys.version`,
    'assert sys.dont_write_bytecode is True, "bytecode writing enabled"',
    'assert site.ENABLE_USER_SITE is False, "user site enabled"',
    'assert not any("rumi-hostile-pythonpath" in p for p in sys.path), sys.path',
    'import build123d, OCP, numpy',
    `assert importlib.metadata.version("build123d") == ${JSON.stringify(lock.build123dVersion)}`,
    `assert importlib.metadata.version("numpy") == ${JSON.stringify(lock.pythonPackages.numpy)}`,
    'box = build123d.Box(10, 10, 10)',
    'assert abs(box.volume - 1000.0) < 1e-6, box.volume',
    'print("RUMI_CAD_SELF_CHECK_OK")',
  ].join('\n')
  const env: NodeJS.ProcessEnv = {
    ...scrubbedEnvironment(),
    PYTHONPATH: '/rumi-hostile-pythonpath',
    PYTHONUSERBASE: '/rumi-hostile-userbase',
    PYTHONDONTWRITEBYTECODE: '0',
    PYTHONNOUSERSITE: '0',
  }
  const output = execFileSync(executable, ['-c', checkScript], { encoding: 'utf8', env, timeout: 120_000 })
  if (!output.includes('RUMI_CAD_SELF_CHECK_OK')) {
    throw new Error('Bundled CAD runtime self-check did not complete')
  }
  if (hasPycache(root)) {
    throw new Error('Bundled CAD runtime wrote __pycache__ during self-check')
  }
}

/**
 * Stage the pinned Python 3.12 + build123d runtime into runtime/cad; a failed preparation publishes no payload.
 * @param target - Architecture of the application being packaged.
 * @param runtime - Build-owned runtime directory; runtime/cad must be absent.
 * @param cache - Shared checksum-addressed download cache.
 * @returns Resolves after archive extraction, wheel unpacking, and native self-check.
 */
export async function prepareCadRuntime(target: Target, runtime: string, cache: string): Promise<void> {
  const destination = join(runtime, 'cad')
  if (existsSync(destination)) {
    throw new Error('CAD runtime destination already exists; prepare a fresh runtime directory')
  }
  const artifact = lock.targets[target]
  const pythonFilename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  const pythonUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonFilename)}`
  const wheels = targetWheels(target)
  const downloads = [
    { url: pythonUrl, sha256: artifact.pythonSha256 },
    ...wheels.map(wheel => ({ url: wheel.url, sha256: wheel.sha256 })),
  ]
  const [pythonArchivePath, ...wheelPaths] = await downloadAllWithConcurrency(
    downloads,
    DOWNLOAD_CONCURRENCY,
    entry => downloadPrimaryRuntimeAsset(entry.url, entry.sha256, cache),
  )
  mkdirSync(runtime, { recursive: true })
  const stage = mkdtempSync(join(runtime, '.cad-'))
  try {
    const raw = join(stage, 'raw')
    mkdirSync(raw)
    await extractTar({ file: pythonArchivePath!, cwd: raw })
    copyPythonTree(join(raw, 'python'), join(stage, 'python'), target)
    rmSync(raw, { recursive: true, force: true })

    const pythonRoot = join(stage, 'python')
    const minor = pythonMinorVersion(lock.pythonVersion)
    const sitePackages = target === 'win-x64'
      ? join(pythonRoot, 'Lib', 'site-packages')
      : join(pythonRoot, 'lib', `python${minor}`, 'site-packages')
    mkdirSync(sitePackages, { recursive: true })
    for (const wheelPath of wheelPaths) {
      await unpackCadWheel(wheelPath, pythonRoot, sitePackages)
    }
    removePycache(stage)

    // Ensure no symlinks exist inside site-packages so macOS signing walks only regular files.
    for (const entry of readdirSync(sitePackages, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        const rel = relative(stage, join(entry.parentPath, entry.name)).split(sep).join('/')
        throw new Error(`CAD runtime: unexpected symlink in site-packages: ${rel}`)
      }
    }

    if (target === 'win-x64') {
      writeFileSync(join(stage, 'cad-python.cmd'), windowsLauncherScript())
    } else {
      cpSync(new URL('./cad-launcher.sh', import.meta.url), join(stage, 'cad-python'))
      chmodSync(join(stage, 'cad-python'), 0o755)
    }

    const platform = desktopTargetPlatform(target)
    const manifest: CadRuntimeManifest = {
      schemaVersion: 1,
      target,
      platform: platform.platform,
      arch: platform.arch,
      python: lock.pythonVersion,
      pythonRelease: lock.pythonRelease,
      build123d: lock.build123dVersion,
      pythonPackages: targetPackageVersions(target),
    }
    writeFileSync(join(stage, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(stage, 'README.txt'), [
      `Rumi CAD runtime`,
      `CPython ${lock.pythonVersion} (python-build-standalone ${lock.pythonRelease})`,
      `build123d ${lock.build123dVersion}, numpy ${lock.pythonPackages.numpy}`,
      `Python archive SHA-256: ${artifact.pythonSha256}`,
      `Pinned wheels: ${wheels.length}`,
      `Isolated runtime: disables bytecode writes and user site-packages.`,
      '',
    ].join('\n'))

    cadRuntimePythonAliases(stage)
    runCadRuntimeSelfCheck(stage, target)
    renameSync(stage, destination)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * Exercise the final packaged CAD runtime and print-studio helpers without user Python leaks or bundle writes.
 * @param resources - Application Resources directory containing runtime/cad and unpacked helpers.
 * @param target - Packaged application architecture; foreign payloads receive presence checks only.
 */
export function smokeCadRuntime(resources: string, target: Target): void {
  const root = join(resources, 'runtime', 'cad')
  const manifest = readCadRuntimeManifest(root)
  if (manifest.target !== target
    || manifest.python !== lock.pythonVersion
    || manifest.pythonRelease !== lock.pythonRelease
    || manifest.build123d !== lock.build123dVersion) {
    throw new Error('Packaged CAD manifest does not match the release lock')
  }
  const executable = join(root, target === 'win-x64' ? 'cad-python.cmd' : 'cad-python')
  const cadDir = join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@rumi', 'print-studio', 'cad')
  const helper = join(cadDir, 'rumi_cad.py')
  const joints = join(cadDir, 'rumi_joints.py')
  const validator = join(cadDir, 'validate.py')
  const robotUsd = join(cadDir, 'robot_usd.py')
  const controlGeometry = join(cadDir, 'control_geometry.py')
  for (const path of [executable, join(root, 'README.txt'), helper, joints, validator, robotUsd, controlGeometry]) {
    if (!existsSync(path)) throw new Error(`Packaged CAD resource is missing: ${path}`)
  }
  cadRuntimePythonAliases(root)
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== process.platform || platform.arch !== process.arch) return

  const python = [
    'import importlib.metadata, pathlib, runpy, site, sys, tempfile',
    `assert sys.version.split()[0] == ${JSON.stringify(lock.pythonVersion)}, sys.version`,
    'assert sys.dont_write_bytecode is True',
    'assert site.ENABLE_USER_SITE is False',
    'assert not any("rumi-hostile-pythonpath" in p for p in sys.path), sys.path',
    'import build123d, OCP, numpy',
    `helper = runpy.run_path(${JSON.stringify(helper)})`,
    `kit = runpy.run_path(${JSON.stringify(joints)})`,
    `val = runpy.run_path(${JSON.stringify(validator)})`,
    'assert callable(helper.get("publish")) and callable(helper.get("restore_revision"))',
    'assert callable(val.get("validate"))',
    'assert len([k for k, v in kit.items() if callable(v) and not k.startswith("_")]) > 0',
    'cube = build123d.Box(40, 40, 40)',
    'cube.label = "cube"',
    'with tempfile.TemporaryDirectory(prefix="rumi-cad-smoke-") as directory:',
    '    report = helper["publish"](directory, [cube], check=False)',
    '    assert report["triangles"] >= 12, report',
    '    assert all(abs(v - 40) < 0.05 for v in report["dimensionsMm"].values()), report',
    '    preview = pathlib.Path(report["preview"])',
    '    assert preview.read_bytes().startswith(b"#usda 1.0")',
    '    step_path = pathlib.Path(report["step"])',
    '    assert step_path.exists() and b"ISO-10303-21" in step_path.read_bytes()[:64]',
    '    imported = helper["import_step"](str(step_path))',
    '    assert abs(imported.volume - 64000.0) < 1.0, imported.volume',
    '    expected = preview.read_bytes()',
    '    preview.write_bytes(b"replace this preview")',
    '    restored = helper["restore_revision"](directory, pathlib.Path(report["revisionUsd"]).parent.name)',
    '    assert preview.read_bytes() == expected',
    '    assert restored["validation"] == "pending" and restored["printReady"] is False',
    '    try: helper["restore_revision"](directory, "../outside")',
    '    except ValueError: pass',
    '    else: raise AssertionError("Revision outside the model accepted")',
    '    assert preview.read_bytes() == expected',
    '    result = val["validate"]({"input": str(preview), "transform": {"scale": 1, "rotate": {"x": 0, "y": 0, "z": 0}, "position": {"x": 0, "y": 0, "z": 0}}, "volume": None, "settings": {"minimumThicknessMm": 1, "degenerateThreshold": 1e-6, "overhangDegrees": 45, "sharpDegrees": 160, "distortionDegrees": 45}})',
    '    assert result["printReady"] is False and result["status"] != "needs_repair", result',
    'print("RUMI_BUNDLED_CAD_OK")',
  ].join('\n')

  const env: NodeJS.ProcessEnv = {
    ...scrubbedEnvironment(),
    PYTHONPATH: '/rumi-hostile-pythonpath',
    PYTHONUSERBASE: '/rumi-hostile-userbase',
    PYTHONDONTWRITEBYTECODE: '0',
    PYTHONNOUSERSITE: '0',
  }
  const output = execFileSync(executable, ['-c', python], { encoding: 'utf8', env, timeout: 120_000 })
  if (!output.includes('RUMI_BUNDLED_CAD_OK')) throw new Error('Packaged CAD smoke did not complete')
  if (platform.platform === 'darwin') {
    const interpreter = join(root, 'python', 'bin', `python${pythonMinorVersion(lock.pythonVersion)}`)
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', interpreter], { env: scrubbedEnvironment(), stdio: 'pipe' })
  }
  // Loading the helpers must not mutate the signed application with Python bytecode.
  if (hasPycache(cadDir) || hasPycache(root)) {
    throw new Error('Packaged CAD runtime wrote __pycache__ into the application')
  }
}
