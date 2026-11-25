/** Rumi's session-title provider turns child prompts into short, stable project names. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { apply as applyProjects } from '../index.js'
import {
  apply,
  buildTitlePrompt,
  frameTitleMessages,
  name,
  selectTitleMessages,
  titleFromOutput,
  titleFromResponse,
} from '../title-provider.js'

const roots: string[] = []
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const BASE_CONFIG = {
  targetWords: 4,
  targetCjkCharacters: 8,
  maxInputBytes: 4096,
  maxOutputTokens: 1024,
  timeoutMs: 10_000,
}

describe('rumi-project-title helpers', () => {
  it('builds initial and anchored prompts with placeholder replacement and stability rules', () => {
    const initial = buildTitlePrompt(BASE_CONFIG, false)
    expect(initial).toContain('4 words')
    expect(initial).toContain('8 CJK characters')
    expect(initial).not.toContain('currentTitle')

    const anchored = buildTitlePrompt(BASE_CONFIG, true)
    expect(anchored).toContain('currentTitle')
    expect(anchored).toContain('generic placeholder')
    expect(anchored).toContain('exactly unchanged')
  })

  it('bounds long message histories within maxInputBytes while keeping ascending seq order', () => {
    const messages = [
      { seq: 1, text: 'Let us build a spinning Mars rover' },
      { seq: 2, text: 'x'.repeat(200) },
      { seq: 3, text: 'y'.repeat(200) },
      { seq: 4, text: 'Add a solar panel on top' },
    ]
    const bounded = selectTitleMessages(messages, 'Mars Rover', 320)
    expect(Buffer.byteLength(bounded.input, 'utf8')).toBeLessThanOrEqual(320)
    expect(bounded.messageSeqs[0]).toBe(1)
    expect(bounded.messageSeqs.at(-1)).toBe(4)
    for (let i = 1; i < bounded.messageSeqs.length; i += 1) {
      expect(bounded.messageSeqs[i]).toBeGreaterThan(bounded.messageSeqs[i - 1])
    }

    const huge = [{ seq: 9, text: '🚀'.repeat(300) }]
    const clipped = selectTitleMessages(huge, undefined, 160)
    expect(Buffer.byteLength(clipped.input, 'utf8')).toBeLessThanOrEqual(160)
    expect(clipped.messageSeqs).toEqual([9])
    expect(() => JSON.parse(clipped.input.split('\n')[1])).not.toThrow()
  })

  it('strips emphasis and wrapping quotes and rejects non-text or truncated responses', () => {
    expect(titleFromOutput('\n  **Spinning Mars Rover**  \nExtra line')).toBe('Spinning Mars Rover')
    expect(titleFromOutput('"Dragon Cup"')).toBe('Dragon Cup')
    expect(titleFromOutput('“Hinged Treasure Box”')).toBe('Hinged Treasure Box')
    expect(titleFromOutput('「齿轮小车」')).toBe('齿轮小车')

    expect(titleFromResponse({
      finish: { kind: 'stop' },
      blocks: [{ type: 'text', text: '"Rocket Ship"' }],
    })).toBe('Rocket Ship')

    expect(() => titleFromResponse({ finish: { kind: 'tool-calls' }, blocks: [] })).toThrow(/text only/u)
    expect(() => titleFromResponse({ finish: { kind: 'max-tokens' }, blocks: [] })).toThrow(/maxOutputTokens/u)
    expect(() => titleFromResponse({
      finish: { kind: 'stop' },
      blocks: [{ type: 'tool-call', id: '1', name: 'bash', arguments: '{}' }],
    })).toThrow(/text only/u)
    expect(() => titleFromResponse({ finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '   ' }] })).toThrow(/no text/u)
  })
})

describe('rumi-project-title plugin registration', () => {
  it('registers an all-prompts provider that runs through the active route and anchors provider titles', async () => {
    let registered: { id: string; automatic: string; generate: (request: object) => Promise<object> } | undefined
    const recorded: unknown[] = []
    let capturedOptions: { system?: string; messages?: { content: { text: string }[] }[]; reasoningEffort?: string } | undefined

    const ctx = {
      sessionTitle: {
        register: vi.fn((provider) => {
          registered = provider
          return () => Promise.resolve()
        }),
      },
      llm: {
        prepareCall: vi.fn(async (controls, _signal, adjust) => {
          const model = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }
          const config = adjust(controls, model)
          return {
            config,
            async *stream(options: typeof capturedOptions) {
              capturedOptions = options
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, text: '"Spinning Mars Rover"' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: '"Spinning Mars Rover"' } }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        }),
      },
    }

    apply(ctx, BASE_CONFIG)
    expect(registered?.id).toBe(name)
    expect(registered?.automatic).toBe('all-prompts')

    const session = {
      id: 'session-1',
      append: (type: string, data: unknown) => recorded.push({ type, data }),
    }
    const messages = [
      { seq: SessionSeq(1), text: 'hi' },
      { seq: SessionSeq(4), text: 'can we make a spinning mars rover?' },
    ]
    const result = await registered!.generate({
      session,
      messages,
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      currentTitle: { title: 'New Project', source: { kind: 'provider', provider: name } },
      signal: new AbortController().signal,
    })

    expect(result).toEqual({
      title: 'Spinning Mars Rover',
      messageSeqs: [1, 4],
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    })
    expect(capturedOptions?.reasoningEffort).toBe('off')
    expect(capturedOptions?.system).toContain('currentTitle')
    expect(capturedOptions?.messages?.[0].content[0].text).toBe(frameTitleMessages(messages, 'New Project'))
    expect(recorded).toHaveLength(1)
  })

  it('names an untitled project through the real SessionTitleService and refines placeholder names', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rumi-project-title-e2e-'))
    roots.push(workspaceRoot)
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    const replies = ['New Project', 'Spinning Mars Rover']

    const ctx = new Context()
    ctx.provide('rumiProjectScope', { workspaceRoot })
    ctx.provide('connection', {
      fetch: {
        register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return () => { routes.delete(route.path) }
        },
      },
    })
    ctx.provide('llm', {
      prepareCall: vi.fn(async (controls, _signal, adjust) => ({
        config: adjust(controls, { reasoning: { efforts: [{ id: 'off' }] } }),
        async *stream() {
          const text = replies.shift() ?? 'Spinning Mars Rover'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      })),
    })

    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
    await ctx.plugin({ name: 'rumi-projects', inject: ['connection', 'rumiProjectScope'], apply: applyProjects })
    await ctx.plugin({ name, inject: ['sessionTitle', 'llm', 'sessions'], apply }, BASE_CONFIG)

    try {
      const request = (path: string, init?: RequestInit) => routes.get(path.split('?')[0])!(new Request(`http://rumi${path}`, init))
      const created = await (await request('/api/rumi-projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      })).json()
      expect(created.project.name).toBe('Untitled 1')

      const session = ctx.sessions.create(brandString<SessionId>('rumi-e2e-session'), { cwd: created.project.path })
      await request('/api/rumi-projects/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: created.project.id, sessionId: session.id }),
      })

      const streamAbort = new AbortController()
      const stream = await routes.get('/api/rumi-projects/events')!(new Request('http://rumi/api/rumi-projects/events', { signal: streamAbort.signal }))
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n')

      // Turn 1: a greeting yields a placeholder name.
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
      const firstUpdate = decoder.decode((await reader.read()).value)
      expect(firstUpdate).toContain('"New Project"')
      expect(JSON.parse(readFileSync(join(created.project.path, 'project.json'), 'utf8')).name).toBe('New Project')

      // Turn 2: a concrete project request refines the placeholder to a real project name.
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'can we build a spinning mars rover' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
      const secondUpdate = decoder.decode((await reader.read()).value)
      expect(secondUpdate).toContain('"Spinning Mars Rover"')
      expect(JSON.parse(readFileSync(join(created.project.path, 'project.json'), 'utf8')).name).toBe('Spinning Mars Rover')

      streamAbort.abort()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
