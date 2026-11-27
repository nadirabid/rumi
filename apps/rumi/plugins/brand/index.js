/** Rumi host policy for model-visible command failures and bundled brand icon delivery. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['tools']

const ICON_PATH = join(import.meta.dirname, 'icon.png')
const ICON_ROUTE = '/api/rumi-brand/icon.png'

/**
 * Report failed foreground Bash commands as errors, preserving their output,
 * and serve the bundled Rumi brand icon to client surfaces.
 * Background starts and promotions have no final exit status and pass through.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Owning plugin context.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scoped) => {
    const iconBytes = readFileSync(ICON_PATH)
    scoped.effect(() => scoped.connection.fetch.register({
      path: ICON_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => new Response(iconBytes, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      }),
    }), `rumi brand: GET ${ICON_ROUTE}`)
  })

  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name !== 'bash' || result.isError) return result
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'foreground') return result
    if (value.exitCode === 0 && value.signal === null && !value.timedOut) return result
    const message = value.timedOut
      ? 'Bash command timed out.'
      : value.signal !== null
        ? `Bash command ended with signal ${value.signal}.`
        : `Bash command failed with exit code ${value.exitCode}.`
    return {
      isError: true,
      error: { message, info: { name: 'ShellCommandError', code: 'RUMI_SHELL_COMMAND_FAILED' } },
      content: result.content,
      ...result.meta === undefined ? {} : { meta: result.meta },
      ...result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts },
    }
  })
}
