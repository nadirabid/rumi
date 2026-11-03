/** Apple acceptance gates ticket recovery; retries never resubmit or suppress persistent failures. */
import { expect, it, vi } from 'vitest'
import { notarizeMacOS } from '../scripts/notarize-macos.mjs'

const options = { appPath: '/test/Rumi.app', keychainProfile: 'test' }
const dependencies = () => ({
  check: vi.fn().mockResolvedValue(undefined),
  submit: vi.fn().mockResolvedValue(undefined),
  staple: vi.fn().mockResolvedValue(undefined),
  wait: vi.fn().mockResolvedValue(undefined),
})

it('retries unavailable ticket downloads after one accepted submission', async () => {
  const ops = dependencies()
  ops.staple.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 68 }))
  await notarizeMacOS(options, ops)
  expect(ops.submit).toHaveBeenCalledTimes(1)
  expect(ops.staple).toHaveBeenCalledTimes(2)
  expect(ops.wait).toHaveBeenCalledWith(15_000)
})

it('does not staple after Apple submission or signature checks fail', async () => {
  for (const phase of ['check', 'submit'] as const) {
    const ops = dependencies()
    ops[phase].mockRejectedValue(new Error('rejected'))
    await expect(notarizeMacOS(options, ops)).rejects.toThrow('rejected')
    expect(ops.staple).not.toHaveBeenCalled()
    expect(ops.wait).not.toHaveBeenCalled()
  }
})

it('stops on permanent stapling errors and exhausts transient retries', async () => {
  for (const code of [65, 68]) {
    const ops = dependencies()
    const failure = Object.assign(new Error('staple failed'), { code })
    ops.staple.mockRejectedValue(failure)
    await expect(notarizeMacOS(options, ops)).rejects.toBe(failure)
    expect(ops.staple).toHaveBeenCalledTimes(code === 68 ? 4 : 1)
    expect(ops.submit).toHaveBeenCalledTimes(1)
    expect(ops.wait.mock.calls.map(([delay]) => delay)).toEqual(code === 68 ? [15_000, 30_000, 60_000] : [])
  }
})
