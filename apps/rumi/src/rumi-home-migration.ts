/**
 * One-time move of Rumi's user data out of the shared Harness home.
 *
 * Earlier builds resolved Rumi's profile and state under `~/.dsh`, beside a
 * DeepSeek Harness installation. Rumi now owns `~/.rumi`; this moves what it
 * already wrote there so the change costs no projects or session history.
 * Every step is guarded by its own destination, so a rerun continues where an
 * interrupted one stopped instead of losing the remainder.
 */

import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** What a migration run did, for the script's report. */
export interface RumiHomeMigrationResult {
  /** True when at least one path moved or was copied. */
  readonly migrated: boolean
  /** Absolute paths renamed into the new home. */
  readonly moved: readonly string[]
  /** Absolute paths copied into the new home, leaving their source in place. */
  readonly copied: readonly string[]
}

/** Files Rumi may have written in the shared home whose original owner still reads them. */
const COPIED_FILES = ['.credentials.yaml', 'live-voice.key'] as const

/** Directory the previous build kept Rumi's own state under. */
const LEGACY_STATE_DIRECTORY = 'rumi'

/**
 * Move one path, creating its parent first.
 * @param from - Existing path to move.
 * @param to - Destination that must not already exist.
 * @returns true when the path moved.
 */
function moveOne(from: string, to: string): boolean {
  if (existsSync(to) || !existsSync(from)) return false
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  renameSync(from, to)
  return true
}

/**
 * Copy one file without overwriting, keeping credentials private.
 * @param from - Existing file to read.
 * @param to - Destination that must not already exist.
 * @returns true when the file was copied.
 */
function copyOne(from: string, to: string): boolean {
  if (existsSync(to) || !existsSync(from)) return false
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  copyFileSync(from, to)
  try {
    // copyFileSync keeps the source mode; a credentials file must not be group-readable.
    chmodSync(to, 0o600)
  } catch (_error) { /* A filesystem without POSIX modes keeps the copied mode as-is. */ }
  return true
}

/**
 * Repoint the moved profile's state rows at the new home.
 *
 * The old rows added a `rumi` prefix inside the shared home; under Rumi's own
 * home the same rows would nest one level deeper than the default roots.
 * @param profileDir - Profile directory in its new location.
 * @returns void
 */
export function repointProfileHomeRows(profileDir: string): void {
  const patch = join(profileDir, 'cordis.patch.yml')
  let text: string
  try {
    text = readFileSync(patch, 'utf8')
  } catch (_error) { return /* A profile without a patch has no rows to repoint. */ }
  const next = text
    .replaceAll("dshHomePath('rumi', 'sessions')", "dshHomePath('sessions')")
    .replaceAll("dshHomePath('rumi', 'storages')", "dshHomePath('storages')")
  if (next !== text) writeFileSync(patch, next)
}

/**
 * Move Rumi's profile, state, and files from the shared Harness home into its own.
 * @param from - Previous shared home, normally `~/.dsh`.
 * @param to - Rumi home, normally `~/.rumi`.
 * @returns Which paths moved or were copied; an already-migrated home returns nothing.
 */
export function migrateRumiHome(from: string, to: string): RumiHomeMigrationResult {
  const moved: string[] = []
  const copied: string[] = []
  if (!existsSync(to)) mkdirSync(to, { recursive: true, mode: 0o700 })

  const profileDestination = join(to, 'profiles', 'rumi')
  if (moveOne(join(from, 'profiles', 'rumi'), profileDestination)) {
    moved.push(profileDestination)
  }
  repointProfileHomeRows(profileDestination)

  // Everything else Rumi owned sits in one directory; move each entry that the
  // new home does not already have.
  const legacyState = join(from, LEGACY_STATE_DIRECTORY)
  if (existsSync(legacyState)) {
    for (const entry of readdirSync(legacyState, { withFileTypes: true })) {
      const destination = join(to, entry.name)
      if (moveOne(join(legacyState, entry.name), destination)) moved.push(destination)
    }
    try {
      rmdirSync(legacyState)
    } catch (_error) { /* The directory still holds data this run did not move; leave it. */ }
  }

  const printerState = join(to, 'print-studio')
  if (moveOne(join(from, 'print-studio'), printerState)) moved.push(printerState)

  for (const name of COPIED_FILES) {
    const destination = join(to, name)
    if (copyOne(join(from, name), destination)) copied.push(destination)
  }

  return { migrated: moved.length > 0 || copied.length > 0, moved, copied }
}
