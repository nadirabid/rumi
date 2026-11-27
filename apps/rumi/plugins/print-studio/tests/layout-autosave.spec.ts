/** Persistence ordering uses explicit completion barriers rather than wall-clock delays. */
import { expect, it, vi } from 'vitest'
import { createLayoutAutosave } from '../viewer/print-layout/autosave.js'

it('serializes writes and coalesces rapid edits to the newest placement', async () => {
  const first = Promise.withResolvers<void>()
  const write = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined)
  const saves = createLayoutAutosave(write, 8)
  try {
    saves.update('kart', { body: 'one' })
    saves.update('kart', { body: 'two' })
    saves.update('kart', { body: 'three' })
    expect(write.mock.calls.map(([request]) => request.body)).toEqual(['one'])
    expect(saves.status('kart')).toBe('saving')
    first.resolve()
    expect(await saves.flush('kart')).toBe(true)
    expect(write.mock.calls.map(([request]) => request.body)).toEqual(['one', 'three'])
    saves.update('kart', { body: 'three' })
    expect(write).toHaveBeenCalledTimes(2)
    expect(saves.hasUnsaved()).toBe(false)
  } finally { first.resolve(); await saves.dispose() }
})

it('retains a failed draft, retries explicitly and keeps model revisions independent', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const saves = createLayoutAutosave(write, 8)
  try {
    saves.update('old', { body: '{"revision":1}' })
    expect(await saves.flush('old')).toBe(false)
    expect(saves.status('old')).toBe('error')
    expect(saves.draft('old')).toEqual({ revision: 1 })
    saves.update('old', { body: '{"revision":1}' })
    expect(write).toHaveBeenCalledTimes(1)
    saves.update('new', { body: '{"revision":2}' })
    expect(await saves.flush('new')).toBe(true)
    expect(saves.status('old')).toBe('error')
    saves.retry('old')
    expect(await saves.flush('old')).toBe(true)
    expect(saves.draft('old')).toBeNull()
    expect(saves.hasUnsaved()).toBe(false)
  } finally { await saves.dispose() }
})

it('finishes a newer edit after an earlier write fails and drains before disposal', async () => {
  const first = Promise.withResolvers<void>(), last = Promise.withResolvers<void>()
  const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise)
  const saves = createLayoutAutosave(write, 8)
  saves.update('kart', { body: 'one' })
  saves.update('kart', { body: 'two' })
  const disposed = saves.dispose()
  saves.update('kart', { body: 'ignored after closing' })
  try {
    first.reject(new Error('offline'))
    await first.promise.catch(() => {})
    expect(write.mock.calls.map(([request]) => request.body)).toEqual(['one', 'two'])
    let finished = false
    void disposed.then(() => { finished = true })
    expect(finished).toBe(false)
    last.resolve()
    await disposed
    expect(finished).toBe(true)
  } finally { first.resolve(); last.resolve(); await disposed }
})


it('contains observer failures without interrupting persistence or later observers', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const observed = vi.fn(), saves = createLayoutAutosave(async () => {}, 8)
  saves.subscribe(() => { throw new Error('observer failed') })
  saves.subscribe(observed)
  try {
    saves.update('kart', { body: '{}' })
    expect(await saves.flush('kart')).toBe(true)
    expect(observed).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledTimes(2)
  } finally { await saves.dispose(); warning.mockRestore() }
})
