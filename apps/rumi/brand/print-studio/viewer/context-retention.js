/** Rumi request-time retention of the harness's existing runtime-context snapshots. */
import { z } from 'zod'

const KEY = 'rumiRuntimeSnapshots'

/**
 * Retain durable evidence while retiring prior runtime snapshots before request admission.
 * Empty developer replacements occupy no model-visible message; the agent loop then
 * admits fresh context through its ordinary providers, including after retries.
 * @param {object} ctx Plugin context with session projections and agent events.
 * @param {Function} createDeveloperMessage Harness message factory supplied by the entrypoint.
 * @returns {Promise<void>} Resolves when the request listener can read a ready projection.
 */
export async function applyContextRetention(ctx, createDeveloperMessage) {
  const projection = await ctx.sessionProjections.register({
    key: KEY,
    stateVersion: 1,
    stateSchema: z.array(z.number().int().nonnegative()),
    init: () => [],
    apply: (state, event) => {
      const replaced = typeof event.surfaceOp === 'object' ? new Set(event.sourceEventSeqs) : null
      const retained = replaced ? state.filter(seq => !replaced.has(seq)) : state
      if (event.type === 'user/message' && event.data.source.kind === 'runtime-context') {
        return [...retained, event.seq]
      }
      return retained
    },
  })
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next()
    signal.throwIfAborted()
    const snapshots = projection.stateOf(agent.session)
    for (const seq of snapshots) {
      agent.session.append('developer/message', {
        turn, step,
        message: createDeveloperMessage({ source: { kind: 'runtime-context' }, content: [] }),
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
    }
    return config
  })
}
