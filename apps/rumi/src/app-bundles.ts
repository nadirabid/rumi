/** Plugin packages Rumi carries inside its runtime and enables in its own profile. */

import { join } from 'node:path'

/** One bundled plugin package and where it lives under the app package root. */
export interface AppBundleSource {
  /** Exact package name, also used as the profile bundle entry and plugin id. */
  readonly name: string
  /** App-package-relative directory containing the package manifest. */
  readonly directory: string
}

/**
 * Bundled plugins in profile activation order. Each package is installed beside
 * `dsh` in the signed runtime, so a fresh profile resolves it without a package
 * manager and the Plugins page reports it as installation-provided.
 */
export const RUMI_APP_BUNDLES: readonly AppBundleSource[] = [
  { name: '@rumi/brand', directory: 'brand' },
  { name: '@rumi/settings', directory: join('brand', 'settings') },
  { name: '@rumi/live-voice', directory: join('brand', 'live-voice') },
  { name: '@rumi/print-studio', directory: join('brand', 'print-studio') },
  { name: '@rumi/projects', directory: join('brand', 'projects') },
]

/** Bundle names seeded into every Rumi profile. */
export const RUMI_APP_BUNDLE_NAMES: readonly string[] = RUMI_APP_BUNDLES.map(bundle => bundle.name)

/**
 * Bundle names an earlier build seeded into every profile and this one no
 * longer ships. A profile that still lists one asks the loader for a package
 * that is not beside `dsh`, so preparation drops it instead of leaving a
 * missing bundle in the manifest.
 */
export const RUMI_RETIRED_BUNDLES: readonly string[] = ['@nmuzaffar/dsh-live-voice']

/**
 * Resolve each bundled plugin's directory from the app package root.
 * @param appRoot - Absolute path of the `apps/rumi` package directory.
 * @returns Bundled packages with absolute source directories.
 */
export function appBundleSources(appRoot: string): { name: string; directory: string }[] {
  return RUMI_APP_BUNDLES.map(bundle => ({ name: bundle.name, directory: join(appRoot, bundle.directory) }))
}
