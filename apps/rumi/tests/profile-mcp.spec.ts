/** Resource ownership and interaction policy in Rumi's composed profile. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains shared resources and question dependencies for existing sessions', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const scopeDir = join(profileDir, 'node_modules', '@rumi')
    mkdirSync(scopeDir, { recursive: true })
    symlinkSync(fileURLToPath(new URL('../brand', import.meta.url)), join(scopeDir, 'brand'))
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(rows.find(row => row.id === 'user-questions')).toMatchObject({ name: '@deepseek-ai/dsh-user-questions' })
    expect(rows.find(row => row.id === 'user-questions')?.disabled).not.toBe(true)
    expect(rows.find(row => row.id === 'ui-user-questions')).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-user-questions' })
    expect(rows.find(row => row.id === 'ui-user-questions')?.disabled).toBe(true)
    for (const id of ['standard', 'ptc', 'cordis']) {
      expect(rows.find(row => row.id === `preset-${id}`)?.disabled).toBe(true)
    }
    expect(rows.find(row => row.id === 'rumi-presets')).toMatchObject({
      name: '@rumi/brand/preset', config: { compactionThresholdRatio: 0.3 },
    })
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('registers the configured compaction threshold on every active Rumi preset', async () => {
  const { apply, Config } = await import('../brand/preset.js')
  const registered: string[] = []
  const ctx = { agentPresets: { register(preset: { id: string; plugins: { id: string; config: { name: string; config: object }[] }[] }) {
    const group = preset.plugins.find(row => row.id === 'compaction')!
    expect(group.config.find(row => row.name === '@deepseek-ai/dsh-compaction-basic')?.config).toEqual({ thresholdRatio: 0.3 })
    registered.push(preset.id)
  } } }
  for await (const _ of apply(ctx, Config.parse({ compactionThresholdRatio: 0.3 }))) { /* Registration runs while the plugin mounts. */ }
  expect(registered).toEqual(['standard', 'ptc', 'cordis'])
})

it('removes questionnaire tools while retaining all other preset capabilities', async () => {
  const { createRequire } = await import('node:module')
  const { loadOptionalPatches } = await import('@deepseek-ai/dsh-app-boot')
  const require = createRequire(fileURLToPath(new URL('../../cli/package.json', import.meta.url)))
  const { withoutQuestionnaire } = await import('../brand/preset.js')
  for (const id of ['standard', 'ptc', 'cordis']) {
    const patches = loadOptionalPatches('rumi', require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`))
    const rows = composeEntries([patches!])
    const original = rows[0]!.config
    const result = withoutQuestionnaire(original)
    expect(result.id).toBe(id)
    expect(result.plugins.map((row: { name: string }) => row.name)).not.toContain('@deepseek-ai/dsh-tool-ask-user')
    expect(result.plugins).toEqual(original.plugins.filter((row: { name: string }) => row.name !== '@deepseek-ai/dsh-tool-ask-user'))
    expect(original.plugins.length).toBe(result.plugins.length + 1)
  }
})
