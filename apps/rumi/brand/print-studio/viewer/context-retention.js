/** Rumi request-time retention policy for harness runtime-context snapshots. */

/**
 * Preserve append-only runtime-context snapshots for provider prompt caching.
 * The harness's `RuntimeContextProjection` suppresses unchanged snapshots and appends
 * a superseding snapshot only when live state changes or after compaction; replacing
 * the latest snapshot on every request invalidates end-of-prompt KV cache checkpoints.
 * @returns {Promise<void>} Resolves immediately with no request-time rewrites.
 */
export async function applyContextRetention() {}
