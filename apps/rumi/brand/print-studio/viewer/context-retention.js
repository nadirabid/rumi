/** Rumi request-time retention of the harness's existing runtime-context snapshots. */
import { z } from 'zod'

const KEY = 'rumiRuntimeSnapshots'

/**
 * Retain durable evidence while retiring prior runtime snapshots before request admission.
 * Empty developer replacements occupy no model-visible message; the agent loop then
 * admits fresh context through its ordinary providers, including after retries.
 * @param {object} ctx Plugin context with session projections and agent events.
 * @param {Function} createDeveloperMessage Harness message factory supplied by the entrypoint.
 * @returns {void}
 */
export function applyContextRetention(ctx, createDeveloperMessage) {
  ctx.effect(() => ctx.sessionProjections.register({
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
  }), 'print viewer: runtime snapshot projection')
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next()
    signal.throwIfAborted()
    const snapshots = ctx.sessionProjections.stateOf(agent.session, KEY)
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
