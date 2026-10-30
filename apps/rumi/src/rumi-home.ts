/** Rumi's own Harness home: the root of every path this app reads or writes. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DSH_HOME_DIR_NAME, expandHomePath } from '@deepseek-ai/dsh-home-paths'

/** Directory name for Rumi's home under the OS home. */
export const RUMI_HOME_DIR_NAME = '.rumi'

/** Environment variable that relocates Rumi's home, for tests and disposable runs. */
export const RUMI_HOME_ENV = 'DSH_RUMI_HOME'

/**
 * Resolve Rumi's home.
 *
 * Rumi is its own product with its own profile, Sessions, credentials, and
 * instructions, so this never consults `$DSH_HOME`: a DeepSeek Harness
 * installation on the same machine must not decide where Rumi keeps its data.
 * @param env - environment mapping read for the optional override.
 * @returns Absolute home path, `~/.rumi` unless `DSH_RUMI_HOME` names another.
 */
export function resolveRumiHome(env: Record<string, string | undefined> = process.env): string {
  const override = env[RUMI_HOME_ENV]
  const selected = override !== undefined && override.trim().length > 0
    ? override
    : join(homedir(), RUMI_HOME_DIR_NAME)
  return resolve(expandHomePath(selected))
}

/**
 * Point the shared Harness path resolvers at Rumi's home.
 *
 * Every downstream resolver — the profile directory, Session and storage
 * roots, credentials, skills, workspace instructions, the provisioning
 * runtimes, and each bundled plugin that reads the home — resolves through
 * `$DSH_HOME`, and the Host inherits it as a launcher-owned variable. Setting
 * it once, before any path is resolved, moves all of them together.
 * @param env - environment mapping to update; defaults to the process's.
 * @returns The home that was applied.
 */
export function applyRumiHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveRumiHome(env)
  env.DSH_HOME = home
  return home
}

/**
 * The shared Harness home that earlier Rumi builds wrote their profile and
 * state into. Only the one-time migration reads it; nothing else may resolve a
 * path there, because a DeepSeek Harness installation owns that directory.
 * @returns Absolute default Harness home, `~/.dsh`.
 */
export function legacyHarnessHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}
