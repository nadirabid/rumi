/** The packaged Host smoke exercises Rumi's shipped profile on a private local port. */
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { smokeProfilePatch } from '../scripts/smoke-runtime.ts'

it('uses an ephemeral loopback port and inherits the shipped profile capabilities', () => {
  expect(load(smokeProfilePatch())).toEqual([{ id: 'webserver', config: { host: '127.0.0.1', port: 0 } }])
})
