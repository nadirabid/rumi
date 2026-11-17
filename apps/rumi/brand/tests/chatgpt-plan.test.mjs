import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../chatgpt.js'

function mount(record, settings = {}) {
  let adapter
  let endpoint
  return apply({
    credentials: { readRecord: async () => record, modifyRecord: async (_key, mutate) => mutate(undefined), deleteRecord: async () => { record = undefined } },
    llm: { registerAdapter: (_routes, registered) => { adapter = registered } },
    effect: setup => setup(),
    connection: { fetch: { register: route => { endpoint = route.fetch } } },
  }, Config.parse(settings)).then(() => ({ adapter, endpoint }))
}

it('keeps a metered environment key out of the disconnected plan route', async () => {
  const original = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'metered-test-key'
  try {
    const { adapter } = await mount()
    assert.deepEqual(await adapter.listModels('rumi-chatgpt'), [])
  } finally { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original }
})

it('restores account models and removes them on disconnect', async () => {
  const { adapter, endpoint } = await mount({ kind: 'grant', payload: {
    token: { type: 'oauth', access: 'fixture', expires: Date.now() + 60000 },
    models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }],
  } })
  assert.deepEqual((await adapter.resolveModel('rumi-chatgpt', 'gpt-6.2-sol')).name, 'GPT-6.2 Sol')
  const request = headers => new Request('http://localhost/api/rumi-chatgpt', {
    method: 'POST', headers, body: JSON.stringify({ action: 'disconnect' }),
  })
  assert.deepEqual((await endpoint(request({}))).status, 403)
  assert.deepEqual((await adapter.listModels('rumi-chatgpt')).length, 1)
  assert.equal((await (await endpoint(request({ 'x-rumi-settings': '1' }))).json()).connected, false)
  assert.deepEqual(await adapter.listModels('rumi-chatgpt'), [])
})

for (const [model, settings, tier] of [
  ['gpt-6.2-sol', { solServiceTier: 'ultrafast' }, 'ultrafast'],
  ['gpt-6.2-sol', {}, undefined],
  ['gpt-6.1-sol', { solServiceTier: 'ultrafast' }, undefined],
]) it(`sends the plan bearer and tools for ${model} with tier ${tier ?? 'auto'}`, async () => {
  const { adapter } = await mount({ kind: 'grant', payload: {
    token: { type: 'oauth', access: 'plan-test-token', expires: Date.now() + 60000 },
    models: [{ id: model, name: model }],
  } }, settings)
  let wire
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options)
    wire = { url: request.url, bearer: request.headers.get('authorization'), body: await request.json() }
    return Response.json({ error: { message: 'fixture ends here' } }, { status: 403 })
  }
  try {
    for await (const chunk of adapter.stream({ provider: 'rumi-chatgpt', model, messages: [],
      tools: [{ name: 'measure', description: 'Measure the project', inputSchema: { type: 'object', properties: {} } }],
    })) { if (chunk.type === 'finish') break }
  } finally { globalThis.fetch = original }
  assert.equal(wire?.url, 'https://api.openai.com/v1/responses')
  assert.equal(wire.bearer, 'Bearer plan-test-token')
  assert.equal(wire.body.service_tier, tier)
  assert.equal(wire.body.store, false)
  assert.equal(wire.body.stream, true)
  assert.equal(wire.body.input[0].tools[0].name, 'measure')
})

it('opens a local callback for the Rumi installation and releases it on cancellation', async () => {
  const { endpoint } = await mount()
  const address = 'http://localhost/api/rumi-chatgpt'
  const post = action => endpoint(new Request(address, { method: 'POST',
    headers: { 'x-rumi-settings': '1' }, body: JSON.stringify({ action }) }))
  try {
    await post('start')
    let status
    for (let i = 0; i < 100; i++) {
      status = await (await endpoint(new Request(address))).json()
      if (status.url || status.failed) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(status.failed, false)
    const url = new URL(status.url)
    assert.equal(url.hostname, 'auth.openai.com')
    assert.equal(url.searchParams.get('agent_name_hint'), 'Rumi')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  } finally {
    assert.equal((await (await post('cancel')).json()).pending, false)
  }
})
