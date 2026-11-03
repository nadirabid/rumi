import { expect, it } from 'vitest'
import { createViewerEvents } from '../viewer/events.js'

it('wakes a pending viewer immediately, retains missed notifications, and releases on abort and disposal', async () => {
  const events = createViewerEvents()
  const controller = new AbortController()
  const pending = events.wait('a', 0, controller.signal)
  events.notify('a')
  expect(await pending).toEqual({ version: 1, closed: false })
  expect(await events.wait('a', 0, controller.signal)).toEqual({ version: 1, closed: false })
  const cancelled = events.wait('a', 1, controller.signal)
  controller.abort()
  expect(await cancelled).toEqual({ version: 1, closed: false })
  const closing = events.wait('b', 0, new AbortController().signal)
  events.dispose()
  expect(await closing).toEqual({ version: 0, closed: true })
})

it('acknowledges only the matching highlight and releases pending work on replacement and disposal', async () => {
  const { createHighlightReceipts } = await import('../viewer/receipts.js')
  const receipts = createHighlightReceipts()
  const signal = new AbortController().signal
  const first = receipts.wait('a', 'one', signal)
  receipts.acknowledge('a', 'other')
  const next = receipts.wait('a', 'two', signal)
  expect(await first).toBe('superseded')
  receipts.acknowledge('a', 'two')
  expect(await next).toBe('rendered')
  const closing = receipts.wait('a', 'three', signal)
  receipts.dispose()
  expect(await closing).toBe('not_rendered')
})
