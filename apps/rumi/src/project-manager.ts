/** Desktop profile initialization and native recovery. */

import {
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import type { DesktopRelease } from './release.ts'
import { readDesktopRuntime } from './runtime-tree.ts'
import {
  initProfile, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, readProfileManifest, removeLinkProjections,
  sanitizeProfile, writeProfileBundles, type ProfileTemplate,
} from '@deepseek-ai/dsh-app-boot'
import { RUMI_APP_BUNDLE_NAMES, RUMI_RETIRED_BUNDLES } from './app-bundles.ts'

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const WEB_PROFILE = PROFILE_TEMPLATES.web as ProfileTemplate
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\n'
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  if (entries.length === 0) return `packages:\n  - .\n\n${WORKSPACE_SETTINGS}`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function migrateProfileSettings(projectDir: string): void {
  const path = join(projectDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return
  const legacy = `packages:\n  - .\n\n${WORKSPACE_SETTINGS}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "${CORE_BUILD_PACKAGE}": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
  if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') === legacy) {
    writeFileSync(path, workspaceFile())
  }
}

/** Initializes the Desktop profile and disables third-party bundles during recovery. */
export class DesktopProjectManager {
  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - location of the bundled application runtime.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: { readonly dsh: string },
  ) {}

  /**
   * Back up the profile patch and disable third-party bundles without loading application resources.
   * The caller must stop the Host first.
   * @returns Backup path after the locked profile write, or undefined if the patch was absent.
   */
  async disableAllPlugins(): Promise<string | undefined> {
    return this.withLock(() => sanitizeProfile('dsh', this.paths.profile, WEB_PROFILE.bundles))
  }

  /**
   * Load application metadata and prepare the external plugin profile without installing packages.
   */
  async applyRelease(): Promise<void> {
    await this.withLock(() => {
      // Validation only: an unreadable or mismatched runtime descriptor stops preparation before the Host starts.
      readDesktopRuntime(this.runtime.dsh)
      migrateProfileSettings(this.paths.profile)
      createPluginProfile(this.paths.profile)
      removeLinkProjections(this.paths.profile)
    })
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    const lockPath = join(realpathSync(this.paths.profile), 'lock')
    let descriptor: number
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(lockPath)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: profile lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another profile operation is active')
        unlinkSync(lockPath)
        descriptor = openSync(lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      writeSync(descriptor, `${String(process.pid)}\n`)
      fsyncSync(descriptor)
      return await operation()
    } finally {
      closeSync(descriptor)
      unlinkSync(lockPath)
    }
  }
}

/** One app-owned plugin package staged beside the core set for the signed runtime. */
export interface RuntimeBundledPackage {
  /** Exact package name. */
  readonly name: string
  /** Project-relative `file:` spec pnpm installs. */
  readonly spec: string
}

/**
 * Create build-only project metadata for materializing the signed runtime.
 * @param projectDir - Build directory containing the verified core package set.
 * @param release - Release identity shared by the packaged runtime.
 * @param bundledPackages - App-owned plugin packages staged under the build directory.
 */
export function createRuntimeProjectMetadata(
  projectDir: string, release: DesktopRelease, bundledPackages: readonly RuntimeBundledPackage[] = [],
): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      ...desktopCorePackageOverrides(packageSet),
      ...Object.fromEntries(bundledPackages.map(entry => [entry.name, entry.spec])),
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...WEB_PROFILE.bundles] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/**
 * Profile policy this app owns, appended once when the profile is created so a
 * fresh install starts in the same shape as an upgraded one: no mode/model/access
 * selectors, project-confined access for every Session, its own brand seats, and the panel
 * launchers folded into the bottom More menu.
 *
 * Rumi's home holds only Rumi, so Session and storage roots stay at their stock
 * defaults under it rather than nesting a second directory inside it.
 */
const RUMI_PROFILE_PATCH = `# Rumi profile policy, seeded by the app. Edit below this block.

# Nobody picks a mode, a model, or an access level in this app.
- id: ui-agent-preset
  disabled: true
- id: ui-model-selection
  disabled: true
- id: ui-permission
  disabled: true

# Every Session starts confined to its project.
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write

# Rumi owns the sidebar brand seats.
- id: ui-brand-official
  disabled: true

# Plugins and Automation tasks live in the bottom More menu.
- id: entry-customization
  disabled: true
`

/** Marker proving the policy block is already in a profile patch. */
const RUMI_POLICY_MARKER = '# Rumi profile policy, seeded by the app.'

/**
 * Update only the app-owned permission block; custom rows retain their contents.
 * @param patch - Existing profile patch text.
 * @returns Patch with the project-confined default, or unchanged text without the owned block.
 */
export function migrateProjectIsolationPolicy(patch: string): string {
  const start = patch.indexOf(RUMI_POLICY_MARKER)
  const end = patch.indexOf('# Rumi owns the sidebar brand seats.', start)
  if (start < 0 || end < 0) return patch
  const owned = patch.slice(start, end)
    .replace('# Every Session runs with full access.', '# Every Session starts confined to its project.')
    .replace('    defaultPreset: danger-full-access', '    defaultPreset: workspace-write')
    .replace('sandbox: workspace-write\n        approval: ask', 'sandbox: workspace-write\n        approval: never')
  return patch.slice(0, start) + owned + patch.slice(end)
}

/** Append the product policy to a profile patch once, leaving user rows alone. */
function ensureProfilePolicy(projectDir: string): void {
  const path = join(projectDir, PROFILE_PATCH_FILENAME)
  let current: string
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    return
  }
  if (current.includes(RUMI_POLICY_MARKER)) {
    const migrated = migrateProjectIsolationPolicy(current)
    if (migrated !== current) writeFileSync(path, migrated, { mode: 0o600 })
    return
  }
  // The template's lone `[]` is an empty layer; replacing it keeps the seeded rows parseable.
  const body = current.replace(/(?:^|\n)\[\]\s*$/u, '').trimEnd()
  writeFileSync(path, `${body === '' ? '' : `${body}\n\n`}${RUMI_PROFILE_PATCH}`, { mode: 0o600 })
}

/** Profile file listing the app bundle defaults this profile has already been offered. */
const APP_BUNDLE_LEDGER = '.rumi-app-bundles.json'

/** Bundle names already offered to this profile, or none when the ledger is absent or unreadable. */
function readAppBundleLedger(projectDir: string): Set<string> {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(projectDir, APP_BUNDLE_LEDGER), 'utf8'))
  } catch { return new Set() /* A profile without a ledger has not been offered any app bundle. */ }
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((name): name is string => typeof name === 'string'))
}

function writeAppBundleLedger(projectDir: string, names: ReadonlySet<string>): void {
  writeFileSync(join(projectDir, APP_BUNDLE_LEDGER), `${JSON.stringify([...names].sort(), undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Offer each app bundle default once. A fresh profile already lists them; an
 * upgraded one gains the bundles added since it was created. Recording the
 * offer keeps a bundle the person later turns off from coming back.
 */
function ensureAppBundleDefaults(projectDir: string): void {
  const offered = readAppBundleLedger(projectDir)
  const pending = RUMI_APP_BUNDLE_NAMES.filter(name => !offered.has(name))
  const manifest = readProfileManifest('dsh', projectDir)
  const current = [...manifest.dsh?.profile?.bundles ?? []]
  const retired = current.some(name => RUMI_RETIRED_BUNDLES.includes(name))
  if (pending.length === 0 && !retired) return
  const bundles = current.filter(name => !RUMI_RETIRED_BUNDLES.includes(name))
  for (const name of pending) {
    if (!bundles.includes(name)) bundles.push(name)
  }
  if (bundles.length !== current.length || bundles.some((name, index) => name !== current[index])) {
    writeProfileBundles(projectDir, manifest, bundles)
  }
  const kept = [...offered].filter(name => !RUMI_RETIRED_BUNDLES.includes(name))
  writeAppBundleLedger(projectDir, new Set([...kept, ...RUMI_APP_BUNDLE_NAMES]))
}

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  initProfile(projectDir, [...WEB_PROFILE.bundles, ...RUMI_APP_BUNDLE_NAMES])
  ensureAppBundleDefaults(projectDir)
  ensureProfilePolicy(projectDir)
}
