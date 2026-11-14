/** Ordered layout persistence outlives viewer panels; only completed placement edits enter this queue. */

/** Create a session-aware autosave owner with explicit retry and shutdown draining.
 * @param {Function} write Persists an immutable request; rejects on any unsuccessful save.
 * @param {number} retained Maximum successful records retained for duplicate suppression.
 * @returns {object} Observable save state, retained drafts, retry, flush and disposal operations.
 */
export function createLayoutAutosave(write, retained) {
  const records = new Map(), listeners = new Set()
  let closed = false
  const notify = () => {
    for (const listener of listeners) {
      try { listener() } catch (error) { console.warn('Layout autosave state listener failed', error) }
    }
  }
  function start(record) {
    record.status = 'saving'
    record.task = (async () => {
      while (record.saved !== record.request.body) {
        const request = record.request
        try { await write(request); record.saved = request.body }
        catch (_error) {
          if (request !== record.request) continue
          record.status = 'error'; return
        }
      }
      record.status = 'idle'
    })().finally(() => {
      record.task = null
      const clean = [...records].filter(([, value]) => value.status === 'idle')
      for (const [key] of clean.slice(0, Math.max(0, clean.length - retained))) records.delete(key)
      notify()
    })
    notify()
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    status(key) { return records.get(key)?.status ?? 'idle' },
    draft(key) { const record = records.get(key); return record && record.status !== 'idle' ? JSON.parse(record.request.body) : null },
    hasUnsaved() { return [...records.values()].some(record => record.status !== 'idle') },
    update(key, request) {
      if (closed) return
      let record = records.get(key)
      if (record?.request.body === request.body) return
      if (!record) { record = { request, saved: null, status: 'idle', task: null }; records.set(key, record) }
      record.request = request
      if (!record.task) start(record)
    },
    retry(key) { const record = records.get(key); if (!closed && record?.status === 'error') start(record) },
    async flush(key) {
      while (records.get(key)?.task) await records.get(key).task
      return !records.has(key) || records.get(key).status === 'idle'
    },
    async dispose() {
      closed = true
      await Promise.all([...records.values()].map(record => record.task))
      listeners.clear(); records.clear()
    },
  }
}
