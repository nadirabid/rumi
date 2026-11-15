/** Client graph/rebuild events; only development launches poll bundle files. */
import z from '@deepseek-ai/schemastery'
import { apply as watchBundles } from '@deepseek-ai/dsh-client-hmr'

/** Host services supplying plugin graph changes and the authenticated HTTP route. */
export const inject = ['clientModules', 'webServer']
/** Deployment-selected filesystem watching; packaged launches use event delivery alone. */
export const Config = z.object({
  watchBundles: z.boolean().default(false),
  pollIntervalMs: z.number().step(1).min(1).default(500),
})

/**
 * Deliver the stock graph/rebuilt protocol without a packaged filesystem timer.
 * @param {object} ctx Host plugin context.
 * @param {object} config Validated deployment watch policy.
 * @returns {void} Routes, subscriptions and streams are released with the plugin.
 */
export function apply(ctx, config) {
  if (config.watchBundles) {
    watchBundles(ctx, { pollIntervalMs: config.pollIntervalMs })
    return
  }
  ctx.effect(() => {
    const connections = new Set()
    const send = frame => {
      const line = `data: ${JSON.stringify(frame)}\n\n`
      for (const response of connections) response.write(line)
    }
    const route = ctx.webServer.register({
      kind: 'exact', path: '/plugins/events',
      handler(request, response) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405); response.end(); return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        connections.add(response)
        response.on('close', () => connections.delete(response))
        response.write(': connected\n\n')
        response.write(`data: ${JSON.stringify({ type: 'graph', graph: ctx.clientModules.graph() })}\n\n`)
      },
    })
    const graph = ctx.clientModules.onGraphChanged(() => send({ type: 'graph', graph: ctx.clientModules.graph() }))
    const rebuilt = ctx.clientModules.onRebuilt((id, rev) => send({ type: 'rebuilt', id, rev }))
    return () => {
      route(); graph(); rebuilt()
      for (const response of connections) response.destroy()
      connections.clear()
    }
  }, 'rumi client graph events')
}
