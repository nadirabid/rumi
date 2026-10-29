/** Stale launch cookies are pruned before the welcome connects. */
import { expect, it, vi } from 'vitest'
import { clearLaunchCookies } from '../src/launch-cookies.ts'

it('removes only cookies minted by an earlier launch', async () => {
  const cookies = {
    get: vi.fn(async () => [
      { name: 'dsh-auth-aaaa' }, { name: 'dsh-auth-bbbb' }, { name: 'unrelated' }, { name: 'dsh-locale' },
    ]),
    remove: vi.fn(async () => {}),
  }
  await clearLaunchCookies(cookies, 'http://127.0.0.1:60000/?token=abc')
  expect(cookies.get).toHaveBeenCalledWith({ url: 'http://127.0.0.1:60000' })
  expect(cookies.remove.mock.calls).toEqual([
    ['http://127.0.0.1:60000', 'dsh-auth-aaaa'],
    ['http://127.0.0.1:60000', 'dsh-auth-bbbb'],
  ])
})
