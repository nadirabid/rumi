import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateRumiHome, repointProfileHomeRows } from '../src/rumi-home-migration.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rumi-home-test-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A shared home shaped like the one earlier builds wrote into. */
function seedSharedHome(root: string): { from: string; to: string } {
  const from = join(root, '.dsh')
  const to = join(root, '.rumi')
  mkdirSync(join(from, 'profiles', 'rumi'), { recursive: true })
  writeFileSync(join(from, 'profiles', 'rumi', 'package.json'), '{"name":"profile"}\n')
  writeFileSync(join(from, 'profiles', 'rumi', 'cordis.patch.yml'), [
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('rumi', 'sessions')",
    '- id: storage-json',
    '  config:',
    "    root: !!js dshHomePath('rumi', 'storages')",
    '',
  ].join('\n'))
  mkdirSync(join(from, 'rumi', 'sessions', 'session-1'), { recursive: true })
  writeFileSync(join(from, 'rumi', 'sessions', 'session-1', 'session.v4.jsonl.zstd'), 'log')
  mkdirSync(join(from, 'rumi', 'storages'), { recursive: true })
  mkdirSync(join(from, 'print-studio'), { recursive: true })
  writeFileSync(join(from, 'print-studio', 'printer.json'), '{}')
  writeFileSync(join(from, '.credentials.yaml'), 'apiKey: secret\n', { mode: 0o644 })
  writeFileSync(join(from, 'live-voice.key'), 'sk-test\n')
  return { from, to }
}

describe('migrateRumiHome', () => {
  it('moves the profile, state, and printer data into Rumi home', () => {
    const { from, to } = seedSharedHome(temporaryRoot())
    const result = migrateRumiHome(from, to)

    expect(result.migrated).toBe(true)
    expect(existsSync(join(to, 'profiles', 'rumi', 'package.json'))).toBe(true)
    expect(readFileSync(join(to, 'sessions', 'session-1', 'session.v4.jsonl.zstd'), 'utf8')).toBe('log')
    expect(existsSync(join(to, 'storages'))).toBe(true)
    expect(readFileSync(join(to, 'print-studio', 'printer.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(from, 'profiles', 'rumi'))).toBe(false)
    expect(existsSync(join(from, 'rumi'))).toBe(false)
  })

  it('copies credentials and the voice key, leaving their source readable', () => {
    const { from, to } = seedSharedHome(temporaryRoot())
    migrateRumiHome(from, to)

    expect(readFileSync(join(to, '.credentials.yaml'), 'utf8')).toBe('apiKey: secret\n')
    expect(readFileSync(join(from, '.credentials.yaml'), 'utf8')).toBe('apiKey: secret\n')
    expect(statSync(join(to, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(to, 'live-voice.key'), 'utf8')).toBe('sk-test\n')
  })

  it('repoints the moved state rows at the new home', () => {
    const { from, to } = seedSharedHome(temporaryRoot())
    migrateRumiHome(from, to)

    const patch = readFileSync(join(to, 'profiles', 'rumi', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("dshHomePath('sessions')")
    expect(patch).toContain("dshHomePath('storages')")
    expect(patch).not.toContain("dshHomePath('rumi'")
  })

  it('is a no-op on a second run', () => {
    const { from, to } = seedSharedHome(temporaryRoot())
    migrateRumiHome(from, to)
    expect(migrateRumiHome(from, to)).toEqual({ migrated: false, moved: [], copied: [] })
  })

  it('keeps data the new home already has', () => {
    const { from, to } = seedSharedHome(temporaryRoot())
    mkdirSync(join(to, 'sessions'), { recursive: true })
    writeFileSync(join(to, 'sessions', 'kept'), 'own')
    migrateRumiHome(from, to)

    expect(readFileSync(join(to, 'sessions', 'kept'), 'utf8')).toBe('own')
    expect(existsSync(join(from, 'rumi', 'sessions'))).toBe(true)
  })

  it('does nothing when the shared home was never used', () => {
    const root = temporaryRoot()
    expect(migrateRumiHome(join(root, '.dsh'), join(root, '.rumi')))
      .toEqual({ migrated: false, moved: [], copied: [] })
  })
})

describe('repointProfileHomeRows', () => {
  it('leaves a profile without a patch alone', () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'profile'), { recursive: true })
    expect(() => repointProfileHomeRows(join(root, 'profile'))).not.toThrow()
  })
})
