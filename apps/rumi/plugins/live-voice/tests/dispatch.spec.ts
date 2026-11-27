import { expect, it } from 'vitest'
import { createVoiceDispatcher } from '../src/dispatch.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('admits a correction while the interval is running and waits for its captured context', async () => {
  const idle = deferred<void>()
  const firstEntered = deferred<void>()
  const correctionEntered = deferred<void>()
  const capture = deferred<object[]>()
  const messages: { text: string; content: object[] }[] = []
  const results: object[] = []
  const agent = { session: { seq: 4 }, steer: (message: { text: string; content: object[] }) => {
    messages.push(message)
    if (messages.length === 1) firstEntered.resolve()
    else correctionEntered.resolve()
  }, whenIdle: () => idle.promise }
  const submit = createVoiceDispatcher({ resolveAgent: async () => agent,
    createMessages: (text: string, content: object[]) => ({ message: { text, content }, reference: null }),
    flush: async () => {}, outcome: () => ({ text: 'Interval result' }),
    finished: (result: object) => results.push(result), closed: () => false })
  const completion = submit({ text: 'Make this flat', content: Promise.resolve([]) })
  await firstEntered.promise
  expect(submit({ text: 'No, this area', content: capture.promise })).toBe(completion)
  idle.resolve()
  expect(results).toEqual([])
  capture.resolve([{ type: 'text', text: 'Captured before delegation' }])
  await correctionEntered.promise
  await completion
  expect(messages.map(message => message.text)).toEqual(['Make this flat', 'No, this area'])
  expect(messages[1]?.content).toEqual([{ type: 'text', text: 'Captured before delegation' }])
  expect(results).toEqual([{ ok: true, text: 'Interval result' }])
})

it('reports resolution failure without leaving a rejected submission', async () => {
  const results: object[] = []
  const submit = createVoiceDispatcher({ resolveAgent: async () => { throw new Error('unavailable') },
    createMessages: () => {}, flush: async () => {}, outcome: () => ({}),
    finished: (result: object) => results.push(result), closed: () => false })
  await submit({ text: 'Stop', content: Promise.resolve([]) })
  expect(results).toEqual([{ ok: false, text: 'unavailable' }])
})

it('submits captured context separately before the untouched spoken message', async () => {
  const { createVoiceMessages } = await import('../src/messages.js')
  const { conversationText } = await import('../src/context.js')
  const sent: { channel: string; message: ReturnType<typeof createVoiceMessages>['message'] }[] = []
  const agent = { session: { seq: 0 },
    inject: (message: ReturnType<typeof createVoiceMessages>['message']) => sent.push({ channel: 'context', message }),
    steer: (message: ReturnType<typeof createVoiceMessages>['message']) => sent.push({ channel: 'speech', message }),
    whenIdle: async () => {} }
  const submit = createVoiceDispatcher({ resolveAgent: async () => agent, createMessages: createVoiceMessages,
    flush: async () => {}, outcome: () => ({ text: 'Ready' }), finished: () => {}, closed: () => false })
  const content = [{ type: 'text' as const, text: '{"reference":"cursor-at-start-of-spoken-request","requestedAt":"2026-11-03T20:00:00.000Z"}' }]
  await submit({ text: 'Flatten this area', content: Promise.resolve(content) })
  expect(sent.map(item => item.channel)).toEqual(['context', 'speech'])
  expect(sent[1]?.message.content).toEqual([{ type: 'text', text: 'Flatten this area' }])
  expect(sent[0]?.message.content).toEqual(content)
  expect(sent[0]?.message.source).toMatchObject({ kind: 'rumi-voice-reference', userMessageId: sent[1]?.message.id, form: 'notice' })
  expect(conversationText(sent[0]!.message)).toBe('')
  expect(createVoiceMessages('Yes', []).reference).toBeNull()
})
