/** Local voice diagnostics retain transcripts and handoff evidence without audio or credentials. */
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Open one private JSONL journal for a live connection; setup failures stop connection startup.
 * @param {string} directory - Configured diagnostics directory.
 * @param {object} identity - Session and live-connection IDs.
 * @param {Function} onError - Stops the owning live connection on a write failure.
 * @returns {object} Ordered record and idempotent close operations.
 */
export function createVoiceJournal(directory, identity, onError) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${identity.liveId}.jsonl`), 'wx', 0o600);
  let closed = false;
  return {
    record(type, data) {
      if (closed) return;
      try { writeSync(fd, JSON.stringify({ time: new Date().toISOString(), ...identity, type, data }) + '\n'); }
      catch (error) { closed = true; closeSync(fd); onError(error); }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
