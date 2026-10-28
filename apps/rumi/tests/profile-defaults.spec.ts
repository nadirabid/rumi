/** Default app bundles in a newly created Rumi profile. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { RUMI_APP_BUNDLE_NAMES } from '../src/app-bundles.ts'
import { createPluginProfile } from '../src/project-manager.ts'

const roots: string[] = []

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rumi-profile-defaults-'))
  roots.push(root)
  return join(root, 'profiles', 'rumi')
}

function profileBundles(profileDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  return manifest.dsh.profile.bundles
}

function writeProfileBundles(profileDir: string, bundles: readonly string[]): void {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  manifest.dsh.profile.bundles = [...bundles]
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('seeds every app bundle into a new profile', () => {
  const profileDir = temporaryProfile()
  createPluginProfile(profileDir)
  expect(profileBundles(profileDir)).toEqual(expect.arrayContaining([...RUMI_APP_BUNDLE_NAMES]))
  expect(existsSync(join(profileDir, '.rumi-app-bundles.json'))).toBe(true)
  expect(JSON.parse(readFileSync(join(profileDir, '.rumi-app-bundles.json'), 'utf8'))).toEqual([...RUMI_APP_BUNDLE_NAMES].sort())
})

it('offers app bundles to a profile created before they existed, once', () => {
  const profileDir = temporaryProfile()
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  expect(profileBundles(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

  createPluginProfile(profileDir)
  expect(profileBundles(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...RUMI_APP_BUNDLE_NAMES])

  // Turning a default off is a choice the next launch must not undo.
  writeProfileBundles(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  createPluginProfile(profileDir)
  expect(profileBundles(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})
