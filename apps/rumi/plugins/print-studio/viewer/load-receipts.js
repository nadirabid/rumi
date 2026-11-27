/**
 * Match model-load completion to a source revision, placement, and build volume.
 * @param {number} timeoutMs - Maximum wait for renderer feedback.
 * @returns {object} Session-scoped wait, update, cancellation, and disposal operations.
 */
export function createLoadReceipts(timeoutMs) {
  const pending = new Map()
  let closed = false
  return {
    wait(sessionId, identity, signal) {
      signal.throwIfAborted()
      if (closed) return Promise.resolve({ status: 'unavailable' })
      pending.get(sessionId)?.finish({ status: 'superseded' })
      return new Promise(resolve => {
        const finish = outcome => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          pending.delete(sessionId)
          resolve(outcome)
        }
        const abort = () => finish({ status: 'cancelled' })
        const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
        pending.set(sessionId, { identity: JSON.stringify(identity), finish })
        signal.addEventListener('abort', abort, { once: true })
      })
    },
    update(sessionId, identity, outcome) {
      const receipt = pending.get(sessionId)
      if (!receipt) return
      if (receipt.identity !== JSON.stringify(identity)) receipt.finish({ status: 'superseded' })
      else if (outcome) receipt.finish(outcome)
    },
    cancel(sessionId) { pending.get(sessionId)?.finish({ status: 'unavailable' }) },
    dispose() {
      closed = true
      for (const receipt of [...pending.values()]) receipt.finish({ status: 'unavailable' })
    },
  }
}
