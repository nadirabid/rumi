/** Bambu Cloud sign-in and access-code lookup. */

import { expect, it } from 'vitest'
import { accessCodeFor, devices, loginMessageToken } from '../cloud.js'

function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

it('reads bound devices and picks the matching access code', async () => {
  const list = [
    { dev_id: 'OTHER', name: 'Other', dev_model_name: 'P1P', dev_access_code: '11111111' },
    { dev_id: '0948AD532400782', name: 'FarmerEngineer', dev_model_name: 'H2D', dev_access_code: '22222222' },
  ]
  const fetched = await devices('token', async () => respond({ devices: list }))
  expect(fetched).toHaveLength(2)
  expect(accessCodeFor(fetched, '0948AD532400782')).toEqual({ code: '22222222', name: 'FarmerEngineer', model: 'H2D' })
})

it('uses the only bound device when the serial is unknown', () => {
  expect(accessCodeFor([{ dev_id: 'ONE', dev_access_code: '33333333' }], '')).toEqual({ code: '33333333', name: null, model: null })
  expect(accessCodeFor([], 'ONE')).toBeNull()
})

it('does not adopt another printer’s access code when the configured serial is absent', () => {
  expect(accessCodeFor([{ dev_id: 'OTHER', dev_access_code: '33333333' }], 'CONFIGURED')).toBeNull()
})

it('exchanges the hosted login ticket with the Bambu ticket endpoint', async () => {
  const token = await loginMessageToken(JSON.stringify({ command: 'user_ticket_login', data: { ticket: 'one/time' } }), async (url, init) => {
    expect(url).toBe('https://api.bambulab.com/v1/user-service/user/ticket/one%2Ftime')
    expect(init.method).toBe('POST')
    return respond({ accessToken: 'session-token' })
  })
  expect(token).toBe('session-token')
})

it('accepts a hosted user_login response carrying an access token', async () => {
  expect(await loginMessageToken(JSON.stringify({ command: 'user_login', data: { accessToken: 'direct-token' } })))
    .toBe('direct-token')
})

it('rejects unrelated page messages and failed ticket exchanges', async () => {
  await expect(loginMessageToken(JSON.stringify({ command: 'new_webpage', data: { token: 'bad' } }))).rejects.toThrow('Invalid Bambu')
  await expect(loginMessageToken(JSON.stringify({ command: 'user_ticket_login', data: { ticket: 'expired' } }), async () => respond({ error: 'Expired ticket' }, 401))).rejects.toThrow('Expired ticket')
})
