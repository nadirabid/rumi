/** Voice consumes canonical session text, including compaction, without private model inputs. */
import { expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createSystemMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { conversationContext, conversationText, contextChunks } from '../src/context.js'

it('uses the retained summary after compaction instead of resurrecting replaced messages', () => {
  const session = new Session(SessionId('context-test'))
  const original = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Obsolete: make it blue.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'We agreed to make a red dragon with a handle.' }],
    source: compactCheckpointSource(CompactionId('test-compaction')),
  }), { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
  const text = conversationContext(session, 16000)
  expect(text).toContain('Earlier conversation summary: We agreed to make a red dragon with a handle.')
  expect(text).not.toContain('Obsolete')
})

it('excludes system instructions and reasoning while preserving assistant replies', () => {
  expect(conversationText(createSystemMessage('Private system prompt'))).toBe('')
  const message = createAssistantMessage({
    content: [{ type: 'reasoning', text: 'Private reasoning' }, { type: 'text', text: 'The handle is ready.' }],
    source: { provider: 'test', model: 'test' },
  })
  expect(conversationText(message)).toBe('assistant: The handle is ready.')
})

it('marks omitted history and retains the most recent text within the configured budget', () => {
  const session = new Session(SessionId('bounded-context'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Old context. '.repeat(20) + 'Make it red.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const text = conversationContext(session, 12)
  expect(text).toContain('[Earlier conversation omitted to fit the context budget.]')
  expect(text.endsWith('Make it red.')).toBe(true)
})

it('chunks long Unicode updates without losing characters or exceeding the append budget', () => {
  const text = 'user: 把这个杯子改成红色🐉。'.repeat(100)
  const chunks = contextChunks(text)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 480)).toBe(true)
  expect(chunks.map(chunk => chunk.slice(chunk.indexOf('\n') + 1)).join('')).toBe(text)
})
