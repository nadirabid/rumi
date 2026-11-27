/** Shared route fallback, markdown-fence JSON parsing, and bounded model dispatch for badge reviewers. */
import { BlockAssembler, HarnessError } from '@deepseek-ai/dsh-llm'

const BASETEN_ROUTE = Object.freeze({
  provider: 'baseten',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast',
  lowestEffort: true,
})

const FALLBACK_ERROR_CODES = new Set([
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'NO_CREDENTIAL_STORE',
  'AUTH_REQUIRED',
  'PROVIDER_NOT_FOUND',
  'UNKNOWN_PROVIDER',
  'ADAPTER_NOT_FOUND',
  'MODEL_UNSUPPORTED',
  'MODEL_NOT_FOUND',
  'UNKNOWN_MODEL',
  'UNSUPPORTED_PROVIDER',
])

const CODE_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/iu

/**
 * Strip optional surrounding Markdown code fences before JSON parsing.
 * @param {string} text Raw text block returned by the evaluator model.
 * @param {(cause?: unknown) => Error} invalidResult Factory for malformed-result errors.
 * @returns {unknown} Parsed JSON value.
 */
export function parseBadgeJson(text, invalidResult) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const unwrapped = CODE_FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed
  try { return JSON.parse(unwrapped) }
  catch (error) { throw invalidResult(error) }
}

/**
 * Find the latest logged provider and model route from a session's `request/header` events.
 * @param {object[]} events Contiguous session events up to the reviewed turn.
 * @returns {{provider: string, model: string} | undefined} Active route, when present.
 */
export function latestSessionRoute(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const cfg = event.data?.header?.config
    if (typeof cfg?.provider === 'string' && cfg.provider && typeof cfg?.model === 'string' && cfg.model) {
      return { provider: cfg.provider, model: cfg.model }
    }
  }
  return undefined
}

function isFallbackError(error) {
  const code = error?.code
  if (typeof code === 'string' && FALLBACK_ERROR_CODES.has(code)) return true
  const message = typeof error?.message === 'string' ? error.message : ''
  return /no (?:api key|credential)|missing credential|unknown provider|provider .* not found|adapter .* not found/iu.test(message)
}

function candidateRoutes(config, sessionRoute) {
  const routes = [{
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    lowestEffort: false,
  }]
  const seen = new Set([`${config.provider}\0${config.model}`])
  const addFallback = (route) => {
    if (!route?.provider || !route?.model) return
    const key = `${route.provider}\0${route.model}`
    if (seen.has(key)) return
    seen.add(key)
    routes.push({ provider: route.provider, model: route.model, lowestEffort: true })
  }
  addFallback(BASETEN_ROUTE)
  addFallback(sessionRoute)
  return routes
}

/**
 * Dispatch one tool-free badge evaluator call, falling back from the primary DeepSeek API route
 * to DeepSeek via Baseten or the session's active provider when credentials or routes are missing.
 * @param {object} ctx Host owner of `ctx.llm`.
 * @param {object} options Request framing, budget, session route fallback, and logger.
 * @returns {Promise<string>} Assembled text response from the winning route.
 */
export async function dispatchBadgeModelCall(ctx, {
  purpose, system, input, log, config, sessionRoute, maxResponseChars, invalidResult, recordMeta, signal,
}) {
  const routes = candidateRoutes(config, sessionRoute)
  const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }]
  let lastError

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]
    const hasMore = index + 1 < routes.length
    signal.throwIfAborted()
    try {
      const prepared = route.lowestEffort
        ? await ctx.llm.prepareCall(
          { provider: route.provider, model: route.model, maxTokens: config.maxOutputTokens },
          signal,
          (controls, modelInfo) => {
            const effort = modelInfo?.reasoning?.efforts?.[0]?.id
            return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
          },
        )
        : await ctx.llm.prepareCall({
          provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort,
          maxTokens: config.maxOutputTokens,
        }, signal)
      const request = { ...prepared.config, purpose, system, messages, sessionId: log.sessionId }
      await log.recordRequest({ ...recordMeta, request })
      signal.throwIfAborted()
      const assembler = new BlockAssembler()
      let characters = 0
      let finished = false
      for await (const chunk of prepared.stream({ ...request, signal })) {
        signal.throwIfAborted()
        if (finished || chunk.type === 'tool-call-delta'
          || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
          || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) throw invalidResult()
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') characters += chunk.text.length
        if (chunk.type === 'finish') finished = true
        if (characters > maxResponseChars) throw invalidResult()
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new HarnessError('Print Studio badge model call failed', finish.failure.code)
      }
      if (!finished || finish.kind !== 'stop') {
        throw new HarnessError('Print Studio badge model call did not complete', 'PRINT_BADGE_REVIEW_INCOMPLETE')
      }
      const blocks = assembler.blocks().filter(block => block.type !== 'reasoning')
      if (blocks.length !== 1 || blocks[0].type !== 'text' || blocks[0].text.length > maxResponseChars) throw invalidResult()
      return blocks[0].text
    } catch (error) {
      lastError = error
      if (signal.aborted || !hasMore || !isFallbackError(error)) throw error
    }
  }
  throw lastError
}
