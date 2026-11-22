/** Client graph/rebuild events; only development launches poll bundle files. */
import z from '@deepseek-ai/schemastery'
import { apply as watchBundles } from '@deepseek-ai/dsh-client-hmr'
import { PluginEvents } from './lib/plugin-events.js'

/** Host service supplying plugin graph and rebuild changes. */
export const inject = ['clientModules']
/** Deployment-selected filesystem watching; packaged launches use event delivery alone. */
export const Config = z.object({
  watchBundles: z.boolean().default(false),
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/**
 * Mount the authenticated plugin events stream and enable bundle polling in development.
 * @param {object} ctx Host plugin context.
 * @param {object} config Validated deployment watch policy.
 */
export function apply(ctx, config) {
  if (config.watchBundles) {
    watchBundles(ctx, { pollIntervalMs: config.pollIntervalMs })
    return
  }
  ctx.plugin(PluginEvents)
}
