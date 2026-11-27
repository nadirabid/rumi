/** Shared filesystem, session-text, and RUMI_MODEL parsing helpers for mechanical and habit badge evidence. */

export const REVISION_PATTERN = /^[a-f\d]{32}$/u
export const PRIVATE_LINE = /\b(password|credentials?|email|authorization|secret|api[_ -]?key|bearer|cookie|token|environ)\b/iu
export const NON_ZERO_BASH = /(?:^|\n)\[(?:exit code: 0*[1-9]|killed by signal:|timed out after |still running after |stopped: )/u
export const MODEL_RECEIPT_PATTERN = /(?:^|\n)RUMI_MODEL (\{[^\r\n]{1,8192}\})(?=\r?\n|$)/gu

/** Return true for absent or broken filesystem path errors. */
export function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)
}

/**
 * Parse JSON within a strict character budget, ignoring syntax errors.
 * @param {unknown} text Raw string to parse.
 * @param {number} maxChars Maximum accepted length.
 * @returns {unknown} Parsed value or undefined.
 */
export function parseJsonBounded(text, maxChars) {
  if (typeof text !== 'string' || text.length > maxChars) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Concatenate text blocks from a session message up to a character cap.
 * @param {{content?: Array<{type?: string, text?: string}>}} message Session message.
 * @param {number} limit Maximum characters to extract.
 * @returns {string}
 */
export function extractMessageText(message, limit) {
  const parts = []
  let remaining = limit
  for (const block of message?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const excerpt = block.text.slice(0, remaining)
    parts.push(excerpt)
    remaining -= excerpt.length
    if (remaining <= 0) break
  }
  return parts.join('\n')
}
