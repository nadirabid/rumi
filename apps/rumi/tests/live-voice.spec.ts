/** Live Voice keeps one session per DSH session and takes context from contributors. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as Projects from '../brand/projects/index.js'
import { describe, expect, it } from 'vitest'
import { composeInstructions, createLiveVoiceRegistry } from '../brand/live-voice/src/registry.js'
import { LiveBridge, speakable, summarize } from '../brand/live-voice/src/bridge.js'
import { CONVERSATION_POLICY, DEFAULT_INSTRUCTIONS, sessionStart, VOICES } from '../brand/live-voice/src/protocol.js'
import { createProjectStore, projectInstructionsFor, renderProjectInstructions } from '../brand/projects/index.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    const text = summarize('A sentence. '.repeat(300), 200)
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
        instructions: (name: string) => renderProjectInstructions({ name, templates: ['## What this project makes'] }),
      }) as { id: string }
      await store.attachSession(project.id, 'session-42')
      const registry = createLiveVoiceRegistry()
      registry.register({ id: 'project', instructions: (sessionId: string) => projectInstructionsFor(store, sessionId) })
      const text = await composeInstructions({ base: DEFAULT_INSTRUCTIONS, contributors: registry.contributors(), sessionId: 'session-42' })
      expect(text.startsWith(DEFAULT_INSTRUCTIONS)).toBe(true)
      expect(text).toContain('# Dragon cup')
      expect(text).toContain('## What this project makes')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('voice delegation lifecycle', () => {
  function fixture() {
    const tasks: string[] = []
    const replies: string[] = []
    const bridge = new LiveBridge({
      dispatch: (task: { text: string }) => tasks.push(task.text),
      commentary: (_id: string, text: string) => replies.push(text),
      thinking: () => {},
    })
    const delegate = (text: string, id: string) => {
      bridge.handleLiveEvent({ type: 'session.input_transcript.delta', delta: text })
      return bridge.handleLiveEvent({ type: 'session.delegation.created', delegation: { id, target: 'client' } })
    }
    return { bridge, delegate, tasks, replies }
  }

  it('discards queued work on close, including when the running turn finishes later', () => {
    const f = fixture()
    f.delegate('Make a cube', 'first')
    f.delegate('Make a sphere', 'second')
    f.bridge.handleLiveEvent({ type: 'session.closed' })
    f.bridge.turnFinished({ text: 'Done' })
    expect(f.tasks).toEqual(['Make a cube'])
    expect(f.replies).toEqual([])
    expect(f.bridge.snapshot()).toMatchObject({ closed: true, queued: 0 })
  })

  it.each(['Stop', '做一个红色的杯子', `Keep the wall 2 mm thick. ${'Add a handle. '.repeat(30)}`])('preserves the full request: %s', (text) => {
    const f = fixture()
    expect(f.delegate(text, 'first')).toBe('dispatched')
    expect(f.tasks).toEqual([text.trim()])
  })

  it('deduplicates delegation IDs, but allows the user to repeat a command', () => {
    const f = fixture()
    f.delegate('Rotate left', 'first')
    f.bridge.turnFinished({ text: 'Done' })
    f.delegate('Rotate left', 'second')
    f.bridge.turnFinished({ text: 'Done' })
    f.bridge.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'second', target: 'client' } })
    expect(f.tasks).toEqual(['Rotate left', 'Rotate left'])
  })
})

it('steers a spoken correction immediately and reports the shared interval to the latest delegation', () => {
  const calls: string[] = []
  const replies: string[] = []
  const bridge = new LiveBridge({
    dispatch: (task: { text: string }) => calls.push(`start:${task.text}`),
    steer: (task: { text: string }) => calls.push(`steer:${task.text}`),
    commentary: (id: string) => replies.push(id), thinking: () => {},
  })
  bridge.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Flatten this area' })
  bridge.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'first' } })
  bridge.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'No, where I am pointing now' })
  expect(bridge.handleLiveEvent({ type: 'session.delegation.created', delegation: { id: 'correction' } })).toBe('steered')
  expect(calls).toEqual(['start:Flatten this area', 'steer:No, where I am pointing now'])
  expect(bridge.snapshot().queued).toBe(0)
  bridge.turnFinished({ text: 'Please confirm the teal area.' })
  expect(replies).toEqual(['correction'])
})

it('records the voice visual-reference requirements', () => {
  expect(DEFAULT_INSTRUCTIONS).toMatchSnapshot()
})


it('keeps mandatory scope when voice instructions are overridden', () => {
  const payload = sessionStart({ instructions: 'Custom speaking style.' })
  expect(payload.session.instructions).toBe(`${CONVERSATION_POLICY}\n\nCustom speaking style.`)
  const template = readFileSync(new URL('../brand/projects/AGENTS_TEMPLATE.md', import.meta.url), 'utf8')
  expect(template).toContain(CONVERSATION_POLICY)
})

it('supplies current scope to existing backend sessions and removes it on unload', async () => {
  const owner = new Context()
  try {
    owner.provide('connection', { fetch: { register: () => () => {} } })
    await owner.plugin(SystemPrompt)
    const fork = owner.plugin(Projects)
    await fork
    const prompt = renderPrompt(await owner.systemPrompt.assemble())
    expect(prompt).toContain(CONVERSATION_POLICY)
    expect(prompt).toMatchSnapshot()
    await fork.dispose()
    expect(renderPrompt(await owner.systemPrompt.assemble())).not.toContain(CONVERSATION_POLICY)
  } finally { await owner.fiber.dispose() }
})
