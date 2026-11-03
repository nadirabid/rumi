/**
 * Session-scoped wakeups for viewer requests; versions prevent lost notifications.
 * @returns {object} Notification, cancellable long-poll and disposal operations.
 */
export function createViewerEvents() {
  const versions = new Map()
  const waiters = new Set()
  let closed = false
  return {
    notify(sessionId) {
      versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1)
      for (const waiter of [...waiters]) if (waiter.sessionId === sessionId) waiter.finish()
    },
    wait(sessionId, after, signal) {
      const version = () => versions.get(sessionId) ?? 0
      if (closed || signal.aborted || after !== version()) return Promise.resolve({ version: version(), closed })
      return new Promise(resolve => {
        const waiter = { sessionId, finish: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', waiter.finish)
          waiters.delete(waiter)
          resolve({ version: version(), closed })
        } }
        const timer = setTimeout(waiter.finish, 25000)
        waiters.add(waiter)
        signal.addEventListener('abort', waiter.finish, { once: true })
      })
    },
    forget(sessionId) {
      versions.delete(sessionId)
      for (const waiter of [...waiters]) if (waiter.sessionId === sessionId) waiter.finish()
    },
    dispose() {
      closed = true
      for (const waiter of [...waiters]) waiter.finish()
      versions.clear()
    },
  }
}
