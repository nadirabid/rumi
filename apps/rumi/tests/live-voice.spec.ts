/** Live Voice keeps one session per DSH session and takes context from contributors. */
import { describe, expect, it } from 'vitest'
import { composeInstructions, createLiveVoiceRegistry } from '../brand/live-voice/lib/registry.js'
import { speakable, summarize } from '../brand/live-voice/lib/bridge.js'
import { DEFAULT_INSTRUCTIONS, VOICES } from '../brand/live-voice/lib/protocol.js'
import { createProjectStore, projectInstructionsFor, renderProjectInstructions } from '../brand/projects/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createLiveVoiceRegistry', () => {
  it('keeps contributions in order and forgets a disposed one', () => {
    const registry = createLiveVoiceRegistry()
    const disposeLate = registry.register({ id: 'late', order: 300, instructions: () => 'late' })
    registry.register({ id: 'early', order: 100, instructions: () => 'early' })
    expect(registry.contributors().map(entry => entry.id)).toEqual(['early', 'late'])
    disposeLate()
    expect(registry.contributors().map(entry => entry.id)).toEqual(['early'])
  })

  it('defaults the order and rejects a duplicate id', () => {
    const registry = createLiveVoiceRegistry()
    registry.register({ id: 'project' })
    expect(registry.contributors()[0]?.order).toBe(100)
    expect(() => registry.register({ id: 'project' })).toThrow(/already registered/u)
  })

  it('rejects a contributor field that is not a function', () => {
    const registry = createLiveVoiceRegistry()
    expect(() => registry.register({ id: 'bad', instructions: 'text' })).toThrow(/must be a function/u)
  })
})

describe('speakable', () => {
  it('drops markdown a voice model would otherwise read out', () => {
    const text = speakable('## Files\n\n- [red_cube.3mf](artifacts/red_cube.3mf) — red material\n\n![preview](artifacts/x.png)\n\nUse `print_studio_status` first.')
    expect(text).toBe('Files red_cube.3mf — red material Use print_studio_status first.')
  })

  it('leaves plain prose alone', () => {
    expect(speakable('The cube is 20 mm wide.')).toBe('The cube is 20 mm wide.')
  })
})

describe('summarize', () => {
  it('cuts a long answer on a sentence boundary within the cap', () => {
    const text = summarize(`${'A sentence. '.repeat(300)}`, 200)
    expect(text.length).toBeLessThanOrEqual(202)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('voice configuration', () => {
  it('offers only voices the Live API accepts', () => {
    expect([...VOICES].sort()).toEqual(['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'])
  })

  it('no longer speaks as a coding agent', () => {
    expect(DEFAULT_INSTRUCTIONS).not.toMatch(/coding agent/u)
    expect(DEFAULT_INSTRUCTIONS).toMatch(/Rumi/u)
  })
})

describe('composeInstructions', () => {
  it('puts the standing orders first, then each contributor in order', async () => {
    const registry = createLiveVoiceRegistry()
    registry.register({ id: 'second', order: 200, instructions: async () => 'CONTRIBUTED SECOND' })
    registry.register({ id: 'first', order: 100, instructions: async () => 'CONTRIBUTED FIRST' })
    const text = await composeInstructions({ base: 'BASE', contributors: registry.contributors(), sessionId: 's' })
    expect(text).toBe('BASE\n\nCONTRIBUTED FIRST\n\nCONTRIBUTED SECOND')
  })

  it('skips a contributor that throws and one that contributes nothing', async () => {
    const seen: string[] = []
    const text = await composeInstructions({
      base: 'BASE',
      contributors: [
        { id: 'broken', instructions: () => { throw new Error('nope') } },
        { id: 'quiet', instructions: async () => '   ' },
        { id: 'loud', instructions: async () => 'LOUD' },
      ],
      sessionId: 's',
      onError: id => seen.push(id),
    })
    expect(text).toBe('BASE\n\nLOUD')
    expect(seen).toEqual(['broken'])
  })

  it("carries a project's AGENTS.md from the projects package", async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-voice-context-'))
    try {
      const store = createProjectStore(root)
      const project = await store.create('Dragon cup', {
        type: 'print',
        instructions: name => renderProjectInstructions({ name, templates: ['## What this project makes'] }),
      })
      await store.attachSession(project.id, 'session-42')
      const registry = createLiveVoiceRegistry()
      registry.register({ id: 'project', instructions: sessionId => projectInstructionsFor(store, sessionId) })
      const text = await composeInstructions({ base: DEFAULT_INSTRUCTIONS, contributors: registry.contributors(), sessionId: 'session-42' })
      expect(text.startsWith(DEFAULT_INSTRUCTIONS)).toBe(true)
      expect(text).toContain('# Dragon cup')
      expect(text).toContain('## What this project makes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
