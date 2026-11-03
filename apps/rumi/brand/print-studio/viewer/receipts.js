/**
 * Pending highlight receipts settle on matching render, replacement, cancellation, or timeout.
 * @returns {object} Session-scoped wait, acknowledgment and disposal operations.
 */
export function createHighlightReceipts() {
  const pending = new Map()
  return {
    has(sessionId) { return pending.has(sessionId) },
    wait(sessionId, id, signal) {
      signal.throwIfAborted()
      pending.get(sessionId)?.finish('superseded')
      return new Promise(resolve => {
        const finish = status => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          pending.delete(sessionId)
          resolve(status)
        }
        const abort = () => finish('cancelled')
        const timer = setTimeout(() => finish('not_rendered'), 8000)
        pending.set(sessionId, { id, finish })
        signal.addEventListener('abort', abort, { once: true })
      })
    },
    acknowledge(sessionId, id) {
      const receipt = pending.get(sessionId)
      if (receipt?.id === id) receipt.finish('rendered')
    },
    fail(sessionId, id, reason) {
      const receipt = pending.get(sessionId)
      if (receipt?.id === id) receipt.finish(reason)
    },
    cancel(sessionId) { pending.get(sessionId)?.finish('not_rendered') },
    dispose() { for (const receipt of [...pending.values()]) receipt.finish('not_rendered') },
  }
}
