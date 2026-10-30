/**
 * Move Rumi's user data out of the shared Harness home, once.
 *
 * Builds before Rumi owned `~/.rumi` kept its profile and state under `~/.dsh`,
 * beside a DeepSeek Harness installation. Run this before launching one of those
 * builds' replacements so the projects and Session history carry over:
 *
 * ```sh
 * node node_modules/tsx/dist/cli.mjs apps/rumi/scripts/migrate-rumi-home.ts
 * ```
 *
 * The move is per-path and skips anything the new home already has, so running
 * it again is safe and an interrupted run resumes on the next invocation.
 */

import { legacyHarnessHome, resolveRumiHome } from '../src/rumi-home.ts'
import { migrateRumiHome } from '../src/rumi-home-migration.ts'

const from = legacyHarnessHome()
const to = resolveRumiHome()
const result = migrateRumiHome(from, to)

if (!result.migrated) {
  console.log(`Nothing to move: ${to} already holds what ${from} had.`)
} else {
  for (const path of result.moved) console.log(`moved  ${path}`)
  for (const path of result.copied) console.log(`copied ${path}`)
}
