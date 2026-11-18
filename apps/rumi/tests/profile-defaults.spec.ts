/** Default app bundles in a newly created Rumi profile. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { RUMI_APP_BUNDLE_NAMES } from '../src/app-bundles.ts'
import { createPluginProfile, migrateProjectIsolationPolicy } from '../src/project-manager.ts'

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

it('removes the seeded model directory disable while preserving a user override', () => {
  const disabled = '- id: ui-model-selection\n  disabled: true\n'
  const marker = '# Rumi profile policy, seeded by the app.\n'
  const sidebar = '# Rumi owns the sidebar brand seats.\n'
  expect(migrateProjectIsolationPolicy(marker + disabled + sidebar + disabled)).toBe(marker + sidebar + disabled)
})

it('upgrades an existing Baseten Flash default and keeps the model used by old chats', () => {
  const profileDir = temporaryProfile()
  createPluginProfile(profileDir)
  const path = join(profileDir, 'cordis.patch.yml')
  const oldModel = 'deepseek-ai/DeepSeek-V4.1-Flash'
  const fastModel = 'deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast'
  const legacy = `- id: llm-pi-ai
  config:
    providers:
      baseten:
        displayName: DeepSeek via Baseten
        apiKeyEnv: BASETEN_API_KEY
        models:
          - id: ${oldModel}
          - id: deepseek-ai/DeepSeek-V4-Pro
- id: agent-default-model
  config:
    provider: baseten
    model: ${oldModel}
    reasoningEffort: low
`
  const seeded = readFileSync(path, 'utf8')
  writeFileSync(path, seeded + legacy)
  createPluginProfile(profileDir)
  const migrated = readFileSync(path, 'utf8')
  expect(load(migrated)).toEqual(expect.arrayContaining([
    { id: 'llm-pi-ai', config: { providers: { baseten: {
      displayName: 'DeepSeek via Baseten', apiKeyEnv: 'BASETEN_API_KEY', models: [
        expect.objectContaining({ id: fastModel, input: ['text', 'image'] }),
        { id: oldModel }, { id: 'deepseek-ai/DeepSeek-V4-Pro' },
      ],
    } } } },
    { id: 'agent-default-model', config: { provider: 'baseten', model: fastModel, reasoningEffort: 'low' } },
  ]))
  createPluginProfile(profileDir)
  expect(readFileSync(path, 'utf8')).toBe(migrated)

  const customized = seeded + legacy.replace('apiKeyEnv: BASETEN_API_KEY', 'apiKeyEnv: CUSTOM_BASETEN_KEY')
  writeFileSync(path, customized)
  createPluginProfile(profileDir)
  expect(readFileSync(path, 'utf8')).toBe(customized)
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
