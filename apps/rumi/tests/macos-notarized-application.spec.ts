/** Verify application qualification commands without invoking Apple tools. */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyMacOSNotarizedApplication } from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const expected = { signingIdentity: 'Example Company (TEAMID1234)', teamId: 'TEAMID1234' }
const appPath = '/private build/DeepSeek Harness.app'
const commands = [
  ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
  ['/usr/bin/codesign', ['--display', '--verbose=4', appPath]],
  ['/usr/bin/xcrun', ['stapler', 'validate', appPath]],
  ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]],
] as const

afterEach(() => { vi.resetAllMocks() })

describe('notarized application qualification', () => {
  it.each([undefined, 0, 1, 2, 3])('stops at failed command %s or verifies every qualification', (failedCommand) => {
    let index = 0
    vi.mocked(spawnSync).mockImplementation(() => ({
      pid: 1,
      output: [],
      stdout: '',
      stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`,
      status: index++ === failedCommand ? 1 : 0,
      signal: null,
    }))
    if (failedCommand === undefined) {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).not.toThrow()
    } else {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('exited with 1')
    }
    const calledCommands = commands.slice(0, failedCommand === undefined ? commands.length : failedCommand + 1)
    expect(spawnSync).toHaveBeenCalledTimes(calledCommands.length)
    for (const [index, [command, args]] of calledCommands.entries()) {
      expect(spawnSync).toHaveBeenNthCalledWith(index + 1, command, args, { encoding: 'utf8', ...(command === '/usr/bin/xcrun' ? { timeout: 120_000 } : {}) })
    }
  })
})

it.each([1, 4])('recovers from or exhausts %s ticket validation failures without bypassing Gatekeeper', (failures) => {
  let attempts = 0
  vi.mocked(spawnSync).mockImplementation(command => ({
    pid: 1, output: [], stdout: '', signal: null,
    stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`,
    status: command === '/usr/bin/xcrun' && ++attempts <= failures ? 68 : 0,
  }))
  if (failures === 1) expect(() => verifyMacOSNotarizedApplication(appPath, expected)).not.toThrow()
  else expect(() => verifyMacOSNotarizedApplication(appPath, expected)).toThrow('exited with 68')
  const calls = vi.mocked(spawnSync).mock.calls
  expect(attempts).toBe(failures === 1 ? 2 : 4)
  expect(calls.filter(([command]) => command === '/bin/sleep').map(([, args]) => args)).toEqual(
    failures === 1 ? [['15']] : [['15'], ['30'], ['60']],
  )
  expect(calls.some(([command]) => command === '/usr/sbin/spctl')).toBe(failures === 1)
})
