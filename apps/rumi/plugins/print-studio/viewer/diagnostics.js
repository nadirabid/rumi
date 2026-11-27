/** Private local highlight traces contain identities and timing, never model bytes, images or credentials. */
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Open a journal lazily on the first highlight event; I/O failures propagate to the owning operation.
 * @param {string} directory - Configured directory for per-process JSONL journals.
 * @returns {object} Record and idempotent close operations.
 */
export function createViewerDiagnostics(directory) {
  let fd = null, closed = false
  return {
    record(sessionId, type, data) {
      if (closed) return
      if (fd === null) {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        fd = openSync(join(directory, `${randomUUID()}.jsonl`), 'wx', 0o600)
      }
      writeSync(fd, JSON.stringify({ time: new Date().toISOString(), monotonicMs: performance.now(), sessionId, type, data }) + '\n')
    },
    close() { if (!closed) { closed = true; if (fd !== null) closeSync(fd) } },
  }
}
