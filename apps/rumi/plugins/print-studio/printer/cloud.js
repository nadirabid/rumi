/** Bambu Cloud account calls used only to fetch a bound printer's LAN access code. */

const BASE = 'https://api.bambulab.com'

/** Parse one JSON response, turning an HTTP failure into a readable error. */
async function readJson(response) {
  const text = await response.text()
  let value
  try {
    value = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`Bambu Cloud returned ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const message = typeof value?.error === 'string'
      ? value.error
      : value?.error?.message ?? value?.message ?? `HTTP ${response.status}`
    throw new Error(`Bambu Cloud: ${message}`)
  }
  return value
}

/**
 * List the account's bound printers.
 * @param {string} token - Bambu Cloud access token.
 * @param {typeof fetch} [fetchImpl] - injectable fetch for tests.
 * @returns {Promise<object[]>} bound devices.
 */
export async function devices(token, fetchImpl = fetch) {
  const response = await fetchImpl(`${BASE}/v1/iot-service/api/user/bind`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const value = await readJson(response)
  if (!Array.isArray(value.devices)) throw new Error('Bambu Cloud: no device list in the response')
  return value.devices
}

/**
 * Find the LAN access code for one printer serial.
 * @param {object[]} list - bound devices.
 * @param {string} serial - printer serial.
 * @returns {{ code: string, name: string | null, model: string | null } | null}
 */
export function accessCodeFor(list, serial) {
  const device = list.find(entry => entry.dev_id === serial)
    ?? (serial === '' && list.length === 1 ? list[0] : undefined)
  if (device === undefined) return null
  const code = typeof device.dev_access_code === 'string' ? device.dev_access_code.trim() : ''
  if (code === '') return null
  return {
    code,
    name: typeof device.name === 'string' ? device.name : null,
    model: typeof device.dev_model_name === 'string' ? device.dev_model_name : null,
  }
}


/** Exchange the short-lived ticket returned by Bambu's hosted sign-in page. */
export async function exchangeTicket(ticket, fetchImpl = fetch) {
  const response = await fetchImpl(`${BASE}/v1/user-service/user/ticket/${encodeURIComponent(ticket)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(15_000),
  })
  const value = await readJson(response)
  const token = value.accessToken ?? value.access_token
  if (typeof token !== 'string' || token === '') throw new Error('Bambu sign-in returned no access token')
  return token
}

/** Validate a hosted-page message before accepting its token or exchanging its ticket. */
export async function loginMessageToken(message, fetchImpl = fetch) {
  if (typeof message !== 'string' || message.length > 65536) throw new Error('Invalid Bambu login response')
  const value = JSON.parse(message)
  if (value?.command === 'user_ticket_login' && typeof value.data?.ticket === 'string' && value.data.ticket !== '') {
    return exchangeTicket(value.data.ticket, fetchImpl)
  }
  if (value?.command === 'user_login') {
    const token = value.data?.token ?? value.data?.accessToken ?? value.data?.access_token
    if (typeof token === 'string' && token !== '') return token
  }
  throw new Error('Invalid Bambu login response')
}
