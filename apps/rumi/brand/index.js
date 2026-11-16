/** Rumi host policy for model-visible command failures. */
export const inject = ['tools']

/**
 * Report failed foreground Bash commands as errors, preserving their output.
 * Background starts and promotions have no final exit status and pass through.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Owning plugin context.
 */
export function apply(ctx) {
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
