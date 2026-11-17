import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../chatgpt.js'

function mount(record, settings = {}, selections = new Map()) {
  let adapter
  let endpoint, speed
  return apply({
    storageDomain: { open: async () => ({ close() {}, table: () => ({ get: key => selections.get(key), put: async (key, value) => selections.set(key, value) }) }) },
    credentials: { readRecord: async () => record, modifyRecord: async (_key, mutate) => mutate(undefined), deleteRecord: async () => { record = undefined } },
    llm: { registerAdapter: (_routes, registered) => { adapter = registered } },
    effect: setup => setup(),
    connection: { fetch: { register: route => { if (route.path.endsWith('/speed')) speed = route.fetch; else endpoint = route.fetch } } },
  }, Config.parse(settings)).then(() => ({ adapter, endpoint, speed }))
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

it('persists a requested tier per conversation and model, including explicit Auto over the Sol default', async () => {
  const selections = new Map()
  const record = { kind: 'grant', payload: { token: { type: 'oauth', access: 'fixture', expires: Date.now() + 60000 },
    models: [{ id: 'gpt-6.2-sol', name: 'Sol', tiers: ['auto', 'priority', 'ultrafast'] },
      { id: 'gpt-6.1-sol', name: 'Sol 6.1', tiers: ['auto'] }] } }
  const open = () => mount(record, { solServiceTier: 'ultrafast' }, selections)
  const session = 'one', model = 'gpt-6.2-sol', path = 'http://localhost/api/rumi-chatgpt/speed'
  const put = (sessionId, model, tier) => new Request(path, { method: 'POST',
    headers: { 'x-rumi-settings': '1' }, body: JSON.stringify({ sessionId, model, tier }) })
  const get = sessionId => new Request(path + '?' + new URLSearchParams({ sessionId, model }))
  const { speed } = await open()
  assert.equal((await (await speed(get(session))).json()).requested, 'ultrafast')
  assert.equal((await speed(put(session, model, 'auto'))).status, 200)
  const reopened = await open()
  assert.equal((await (await reopened.speed(get(session))).json()).requested, 'auto')
  assert.equal((await (await reopened.speed(get('two'))).json()).requested, 'ultrafast')
  assert.equal((await speed(put(session, 'gpt-6.1-sol', 'priority'))).status, 422)
  await speed(put(session, model, 'priority'))
  let payload
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    payload = await new Request(url, options).json()
    return Response.json({ error: { message: 'fixture' } }, { status: 403 })
  }
  try {
    for await (const chunk of reopened.adapter.stream({ provider: 'rumi-chatgpt', model, sessionId: session, messages: [] })) {
      if (chunk.type === 'finish') break
    }
  } finally { globalThis.fetch = original }
  assert.equal(payload.service_tier, 'priority')
})
