import { afterEach, expect, it, vi } from 'vitest'
import { LiveBridge } from '../src/bridge.js'
import { createVoiceDispatcher } from '../src/dispatch.js'

afterEach(() => vi.useRealTimers())

it('waits for late text once, expires missing text visibly, and cancels timers on close', async () => {
  vi.useFakeTimers()
  const tasks: string[] = [], replies: string[] = [], states: string[] = []
  const bridge = new LiveBridge({ dispatch: (task: { text: string }) => tasks.push(task.text),
    commentary: (_id: string, text: string) => replies.push(text), thinking: () => {},
    state: (_id: string, state: string) => states.push(state), transcriptWaitMs: 100 })
  const delegate = (id: string) => bridge.handleLiveEvent({ type: 'session.delegation.created', delegation: { id } })
  expect(delegate('first')).toBe('waiting')
  expect(delegate('first')).toBe('ignored')
  bridge.handleLiveEvent({ type: 'session.input_transcript.delta', delta: 'Highlight here' })
  expect(tasks).toEqual(['Highlight here'])
  bridge.turnFinished({ text: 'Ready' })
  delegate('missing')
  await vi.advanceTimersByTimeAsync(100)
  expect(states.at(-1)).toBe('failed')
  expect(replies.at(-1)).toContain('not sent')
  delegate('closing')
  bridge.close()
  await vi.advanceTimersByTimeAsync(100)
  expect(tasks).toEqual(['Highlight here'])
  expect(vi.getTimerCount()).toBe(0)
})

it('never submits a request that resolves after the acceptance timeout', async () => {
  vi.useFakeTimers()
  let resolve!: (value: object) => void
  const ready = new Promise(done => { resolve = done })
  const steer = vi.fn(), accepted = vi.fn(), failed = vi.fn()
  const submit = createVoiceDispatcher({ resolveAgent: () => ready, createMessages: () => ({ message: {}, reference: null }),
    accepted, failed, timeoutMs: 100, flush: async () => {}, outcome: () => ({}), finished: () => {}, closed: () => false })
  const done = submit({ delegationId: 'late', text: 'Highlight', content: Promise.resolve([]) })
  await vi.advanceTimersByTimeAsync(100)
  await done
  resolve({ session: { seq: 0 }, steer, whenIdle: async () => {} })
  await ready
  expect(failed).toHaveBeenCalledOnce()
  expect(accepted).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
