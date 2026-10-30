import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyRumiHome, legacyHarnessHome, resolveRumiHome } from '../src/rumi-home.ts'

describe('resolveRumiHome', () => {
  it('defaults to ~/.rumi', () => {
    expect(resolveRumiHome({})).toBe(join(homedir(), '.rumi'))
  })

  it('ignores the shared Harness home', () => {
    expect(resolveRumiHome({ DSH_HOME: '/tmp/shared-home' })).toBe(join(homedir(), '.rumi'))
  })

  it('honours the Rumi override and expands a tilde', () => {
    expect(resolveRumiHome({ DSH_RUMI_HOME: '~/elsewhere' })).toBe(join(homedir(), 'elsewhere'))
    expect(resolveRumiHome({ DSH_RUMI_HOME: '/tmp/rumi-home' })).toBe('/tmp/rumi-home')
  })

  it('treats a blank override as unset', () => {
    expect(resolveRumiHome({ DSH_RUMI_HOME: '   ' })).toBe(join(homedir(), '.rumi'))
  })
})

describe('applyRumiHome', () => {
  it('points the shared resolvers at Rumi home', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '/tmp/shared-home' }
    expect(applyRumiHome(env)).toBe(join(homedir(), '.rumi'))
    expect(env.DSH_HOME).toBe(join(homedir(), '.rumi'))
  })
})

describe('legacyHarnessHome', () => {
  it('names the shared home only the migration reads', () => {
    expect(legacyHarnessHome()).toBe(join(homedir(), '.dsh'))
  })
})
