/** Exercise the production reviewer and DeepSeek API route against labeled Blender revisions. */
import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import DeepSeekAuth from '@deepseek-ai/dsh-deepseek-auth'
import Llm from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { capturePrintBadgeRevisions, reviewPrintBadges } from '../badges/review.js'

const fixtureRoot = await realpath(process.argv[2])
const cases = {
  plain: [], wheel: ['wheel-and-axle'], independent: ['wheel-and-axle'],
  barrel: ['barrel-hinge'], fold: ['living-hinge'], rail: ['dovetail-slide'],
  gears: ['gear-pair'], rack: ['rack-and-pinion'], 'custom-fold': ['living-hinge'], 'shallow-groove': [],
}
const ctx = new Context()
try {
  await ctx.plugin(Credentials, { dshHome: process.env.DSH_RUMI_HOME || join(homedir(), '.rumi'), watch: false })
  await ctx.plugin(Llm)
  await ctx.plugin(DeepSeekAuth)
  await ctx.plugin(DeepSeek, {})
  const config = { enabled: true, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off',
    timeoutMs: 30000, maxOutputTokens: 1200 }
  const failed = []
  for (const [name, expected] of Object.entries(cases)) {
    const path = join(fixtureRoot, name)
    const targets = capturePrintBadgeRevisions(path).map(target => ({ ...target, changed: true }))
    assert.equal(targets.length, 1, name)
    const events = ['custom-fold', 'shallow-groove'].includes(name) ? [{ seq: 0, type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Can the two panels fold together without adding a pin?' }] } }] : []
    const requests = []
    const findings = await reviewPrintBadges(ctx, {
      session: { id: 'badge-qualification' }, project: { path }, turnEndSeq: 1, events, targets,
      signal: AbortSignal.timeout(65000), recordRequest: async request => { requests.push(request) },
    }, config)
    const kinds = findings.map(item => item.kind).sort()
    console.log(name, kinds.join(', ') || '(none)', '—', requests.length, 'request(s)')
    if (JSON.stringify(kinds) !== JSON.stringify(expected)) failed.push({ name, expected, kinds })
    assert.ok(requests.length > 0 && requests.length <= 2)
  }
  assert.deepEqual(failed, [], 'Live mechanical badge classifications')
} finally {
  await ctx.fiber.dispose()
}
