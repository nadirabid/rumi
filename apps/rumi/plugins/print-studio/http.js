/** Shared HTTP JSON response and body parsing helpers for Print Studio routes. */

export const JSON_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'content-type': 'application/json',
  'x-content-type-options': 'nosniff',
})

/**
 * Serialize a value as a non-cacheable JSON HTTP response.
 * @param {unknown} value JSON-serializable payload.
 * @param {number} [status=200] HTTP status code.
 * @returns {Response}
 */
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/**
 * Parse a JSON request body, returning an empty object when malformed.
 * @param {Request} request Incoming HTTP request.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}
