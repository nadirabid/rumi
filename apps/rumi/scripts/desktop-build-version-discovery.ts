/**
 * Suggest the next build version for a product version from existing local artifacts.
 */

import { readdir } from 'node:fs/promises'
import { parse } from 'semver'
import { desktopBuildVersionPrefix, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import type { DesktopPackageTargetName } from './package-target.ts'

/** Artifact name electron-builder writes for one build; unsigned and unnotarized builds add a suffix. */
const ARTIFACT = /(?:^|\/)(?:rumi|deepseek-harness)-(?<version>.+)-mac-(?:arm64|x64)(?:-unsigned|-unnotarized)?\.(?:dmg|zip)$/u

/** Inputs that decide which versions are already taken. */
export interface DesktopBuildVersionSuggestionOptions {
  readonly productVersion: string
  readonly target: DesktopPackageTargetName
  readonly environment: NodeJS.ProcessEnv
  /** Date segment to number within; defaults to today where the build runs. */
  readonly date?: string
  /** Directory electron-builder writes installers into for this build. */
  readonly artifactsRoot: string
}

/**
 * Format a date as the convention's segment.
 * @param date - Date to format.
 * @returns The date as `YYYYMMDD` in the build host's own time zone.
 */
export function desktopBuildDateSegment(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${String(date.getFullYear())}${month}${String(date.getDate()).padStart(2, '0')}`
}

function sequenceNumbers(versions: Iterable<string>, prefix: string): number[] {
  const numbers: number[] = []
  for (const version of versions) {
    if (!version.startsWith(prefix)) continue
    const index = version.slice(prefix.length)
    if (/^\d+$/u.test(index)) numbers.push(Number(index))
  }
  return numbers
}

async function localVersions(artifactsRoot: string): Promise<string[]> {
  const entries = await readdir(artifactsRoot).catch(() => [])
  return entries.map(entry => ARTIFACT.exec(entry)?.groups?.version)
    .filter((version): version is string => version !== undefined && parse(version) !== null)
}

/**
 * Suggest the next build version for today, numbering after what is already taken.
 * @param options - Product version, target, and artifact directory to search.
 * @returns A validated build version whose index is free.
 */
export async function suggestDesktopBuildVersion(options: DesktopBuildVersionSuggestionOptions): Promise<string> {
  const prefix = `${desktopBuildVersionPrefix(options.productVersion)}${options.date ?? desktopBuildDateSegment()}.`
  const taken = await localVersions(options.artifactsRoot)
  const used = sequenceNumbers(taken, prefix)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  const suggestion = validateDesktopBuildVersion(`${prefix}${String(next)}`, options.productVersion)
  process.stdout.write(`desktop package: numbering ${suggestion} after ${String(used.length)} local artifact${used.length === 1 ? '' : 's'} for ${prefix}*\n`)
  return suggestion
}
