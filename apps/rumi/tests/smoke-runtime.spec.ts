/** Verify smoke profile patches keep Host isolation and contention-safe Office Kit timeouts. */

import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  assertOfficeSkillsLoadable,
  SMOKE_OFFICE_TIMEOUT_MS,
  smokeProfilePatch,
} from '../scripts/smoke-runtime.ts'

interface PatchRow {
  id: string
  config?: Record<string, unknown>
}

describe('smokeDesktopRuntime helpers', () => {
  it('configures an isolated ephemeral webserver and a contention-safe Office Kit timeout', () => {
    const home = '/tmp/dsh-smoke "quoted" dir'
    const rows = load(smokeProfilePatch(home)) as PatchRow[]
    expect(rows).toEqual([
      {
        id: 'webserver',
        config: {
          host: '127.0.0.1',
          port: 0,
        },
      },
      {
        id: 'office-kit',
        config: {
          outputDirectory: join(home, 'office-kit', 'outputs'),
          timeoutMs: SMOKE_OFFICE_TIMEOUT_MS,
        },
      },
    ])
    expect(SMOKE_OFFICE_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000)
  })

  it('requires a nonempty office skill body', () => {
    expect(() => { assertOfficeSkillsLoadable([{ name: 'office', bytes: 128 }]) }).not.toThrow()
    expect(() => { assertOfficeSkillsLoadable([{ name: 'office', bytes: 0 }]) }).toThrow(/not loadable/u)
  })
})
