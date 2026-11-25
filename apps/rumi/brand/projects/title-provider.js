/** Rumi project title provider for `ctx.sessionTitle`. */
import z from '@deepseek-ai/schemastery'
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import { SessionTitleProviderId, normalizeSessionTitle, truncateTitleUtf8 } from '@deepseek-ai/dsh-session-title'
import {
  executeSessionTitleLlm,
  resolveSessionTitleLlmConfig,
  SessionTitleLlmConfigFields,
} from '@deepseek-ai/dsh-session-title-llm'

/** Plugin row id registered in Rumi's profile patch. */
export const name = 'rumi-project-title'

/** Services required to register the title provider and run auxiliary LLM calls. */
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Loader schema for required execution limits and title-length targets. */
export const Config = z.object({
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u
const QUOTE_WRAPPERS = [
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
]

function assertTarget(field, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}: ${field} must be a positive integer`)
  }
  return value
}

/**
 * Validate provider execution controls and title-length targets.
 * @param {object} config - Plugin configuration from the profile patch.
 * @returns {object} Immutable resolved configuration.
 */
export function resolveConfig(config) {
  const { targetWords, targetCjkCharacters, ...execution } = config
  return {
    ...resolveSessionTitleLlmConfig(execution),
    targetWords: assertTarget('targetWords', targetWords),
    targetCjkCharacters: assertTarget('targetCjkCharacters', targetCjkCharacters),
  }
}

/** Select the route's lowest supported reasoning effort for a title call. */
const selectReasoningEffort = (model) => model.reasoning?.efforts[0]?.id

/**
 * Build the system instruction for naming a Rumi project.
 * @param {{ targetWords: number, targetCjkCharacters: number }} config - Title length targets.
 * @param {boolean} hasCurrentTitle - Whether an existing provider title is supplied as an anchor.
 * @returns {string} System prompt text.
 */
export function buildTitlePrompt(config, hasCurrentTitle) {
  return [
    "Create a short, plain project name for a child's Rumi project from the supplied messages.",
    'Return only the name on one line in plain natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use simple, concrete words the child would use (for example, Dragon Cup or Spinning Mars Rover) in the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages only contain a greeting or do not yet name what is being made, return a short placeholder such as New Project instead of explaining.',
    ...hasCurrentTitle ? [
      'An existing name is supplied as currentTitle. If it is only a generic placeholder (such as New Project or Greeting) and the messages now describe what is being made, replace it with a concrete name for the project.',
      'Otherwise, if currentTitle still accurately names what is being made, return it exactly unchanged.',
      'Follow-up edits, size adjustments, repairs, acknowledgements, and questions about the same object do not justify changing the name. Keeping its exact wording takes priority over the target length.',
      'Change a concrete name only when the messages clearly switch to making a different project.',
    ] : [],
  ].join('\n')
}

/**
 * Frame selected human messages as JSON so user text cannot break structural delimiters.
 * @param {readonly { seq: number, text: string }[]} messages - Selected messages in ascending seq order.
 * @param {string} [currentTitle] - Anchored provider title when one already exists.
 * @returns {string} Framed user prompt for the auxiliary LLM call.
 */
export function frameTitleMessages(messages, currentTitle) {
  if (currentTitle !== undefined) {
    return `Update the project name from this JSON object:\n${JSON.stringify({ currentTitle, messages })}`
  }
  return `Generate a project name from this JSON array of messages:\n${JSON.stringify(messages)}`
}

/**
 * Keep the framed message payload within `maxInputBytes` while preserving the first
 * message and the most recent context in ascending seq order.
 * @param {readonly { seq: number, text: string }[]} messages - All eligible human messages in seq order.
 * @param {string | undefined} currentTitle - Anchored provider title, if any.
 * @param {number} maxInputBytes - Hard UTF-8 byte ceiling for the framed prompt.
 * @returns {{ input: string, messageSeqs: number[] }} Bounded prompt and exact source seqs.
 */
export function selectTitleMessages(messages, currentTitle, maxInputBytes) {
  if (messages.length === 0) throw new Error(`${name}: at least one human message is required`)
  const full = frameTitleMessages(messages, currentTitle)
  if (Buffer.byteLength(full, 'utf8') <= maxInputBytes) {
    return { input: full, messageSeqs: messages.map(message => message.seq) }
  }
  const first = messages[0]
  const tail = []
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const candidate = [first, messages[index], ...tail]
    if (Buffer.byteLength(frameTitleMessages(candidate, currentTitle), 'utf8') <= maxInputBytes) {
      tail.unshift(messages[index])
    } else {
      break
    }
  }
  const selected = [first, ...tail]
  const framed = frameTitleMessages(selected, currentTitle)
  if (Buffer.byteLength(framed, 'utf8') <= maxInputBytes) {
    return { input: framed, messageSeqs: selected.map(message => message.seq) }
  }
  // Even a single message exceeded the byte ceiling: truncate its text to fit cleanly.
  const latest = messages.at(-1)
  const overhead = Buffer.byteLength(frameTitleMessages([{ seq: latest.seq, text: '' }], currentTitle), 'utf8')
  const budget = Math.max(0, maxInputBytes - overhead)
  let low = 0
  let high = Math.min(latest.text.length, budget)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const clipped = truncateTitleUtf8(latest.text, mid)
    const size = Buffer.byteLength(frameTitleMessages([{ seq: latest.seq, text: clipped }], currentTitle), 'utf8')
    if (size <= maxInputBytes) low = mid
    else high = mid - 1
  }
  const clipped = truncateTitleUtf8(latest.text, low)
  const finalInput = frameTitleMessages([{ seq: latest.seq, text: clipped }], currentTitle)
  if (Buffer.byteLength(finalInput, 'utf8') > maxInputBytes) {
    throw new Error(`${name}: maxInputBytes ${maxInputBytes} is too small for the title prompt`)
  }
  return { input: finalInput, messageSeqs: [latest.seq] }
}

/**
 * Extract the title from raw model output: first non-empty line, without
 * whole-line emphasis or wrapping quote pairs.
 * @param {string} text - Raw text returned by the title model.
 * @returns {string} Candidate title before final normalization.
 */
export function titleFromOutput(text) {
  let line = text.split(/\r?\n/u).map(item => item.trim()).find(item => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  if (groups?.marker && groups.inner && !groups.inner.includes(groups.marker)) {
    line = groups.inner
  }
  for (const [open, close] of QUOTE_WRAPPERS) {
    if (line.length > open.length + close.length && line.startsWith(open) && line.endsWith(close)) {
      const inner = line.slice(open.length, line.length - close.length).trim()
      if (inner.length > 0 && !inner.includes(close)) {
        line = inner
        break
      }
    }
  }
  return line
}

/**
 * Validate an auxiliary title model response and return the normalized title.
 * @param {{ finish: { kind: string }, blocks: readonly { type: string }[] }} response - Assembled LLM response.
 * @returns {string} Non-empty normalized project title.
 */
export function titleFromResponse(response) {
  if (response.finish.kind === 'tool-calls') {
    throw new Error(`${name}: title output must contain text only`)
  }
  if (response.finish.kind === 'max-tokens') {
    throw new Error(`${name}: title output reached maxOutputTokens`)
  }
  if (response.finish.kind !== 'stop') {
    throw new Error(`${name}: unexpected finish kind ${response.finish.kind}`)
  }
  if (response.blocks.some(block => block.type === 'tool-call')) {
    throw new Error(`${name}: title output must contain text only`)
  }
  const text = extractTextContent(response.blocks, { separator: ' ' })
  const title = normalizeSessionTitle(titleFromOutput(text), Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error(`${name}: title model produced no text`)
  return title
}

/**
 * Register the Rumi project title provider with `ctx.sessionTitle`.
 * @param {object} ctx - Cordis context exposing `sessionTitle`, `llm`, and `sessions`.
 * @param {object} config - Required route, target, byte, token, and timeout policy.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const titleProvider = SessionTitleProviderId(name)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'all-prompts',
    async generate(request) {
      const anchor = request.currentTitle?.source.kind === 'provider' ? request.currentTitle.title : undefined
      const { input, messageSeqs } = selectTitleMessages(request.messages, anchor, resolved.maxInputBytes)
      const response = await executeSessionTitleLlm(ctx, resolved, request, titleProvider, {
        system: buildTitlePrompt(resolved, anchor !== undefined),
        input,
        messageSeqs,
        selectReasoningEffort,
      })
      return {
        title: titleFromResponse(response),
        messageSeqs,
        model: response.model,
      }
    },
  })
}
