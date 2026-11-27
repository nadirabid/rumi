import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'node:http'
import { apply, Config } from '../chatgpt.js'

const provider = 'rumi-chatgpt'
const account = `${provider}/account`
const model = 'gpt-6.2-sol'
const planModels = [{ id: model, name: 'GPT-6.2 Sol', tiers: ['auto'] }]
const expiredGrant = { kind: 'grant', payload: { models: planModels, token: {
  type: 'oauth', access: 'old-access', refresh: 'old-refresh', clientId: 'first-client', expires: 0,
} } }
const endpointRequest = (action) => new Request('http://localhost/api/rumi-chatgpt', action ? {
  method: 'POST', headers: { 'x-rumi-settings': '1' }, body: JSON.stringify({ action }),
} : undefined)

function mount(record, settings = {}, selections = new Map()) {
  let adapter
  let endpoint, speed
  const records = new Map(record ? [[account, record]] : [])
  let writes = Promise.resolve()
  return apply({
    storageDomain: { open: async () => ({ close() {}, table: () => ({ get: key => selections.get(key), put: async (key, value) => selections.set(key, value) }) }) },
    credentials: { readRecord: async key => records.get(key), modifyRecord(key, mutate) {
      const operation = writes.then(async () => {
        const current = records.get(key)
        const next = await mutate(current)
        if (next !== undefined) records.set(key, next)
        return next ?? current
      })
      writes = operation.then(() => undefined, () => undefined)
      return operation
    }, deleteRecord: async key => { records.delete(key) } },
    llm: { registerAdapter: (_routes, registered) => { adapter = registered } },
    effect: setup => setup(),
    connection: { fetch: { register: route => { if (route.path.endsWith('/speed')) speed = route.fetch; else endpoint = route.fetch } } },
  }, Config.parse(settings)).then(() => ({ adapter, endpoint, speed, accountRecord: () => records.get(account) }))
}

async function send(adapter) {
  for await (const chunk of adapter.stream({ provider, model, messages: [] })) {
    if (chunk.type === 'finish') break
  }
}

it('only renews on inference and atomically stores the replacement for concurrent requests', async (t) => {
  const { adapter, accountRecord, endpoint, speed } = await mount(expiredGrant)
  const refresh = Promise.withResolvers()
  const allowRefresh = Promise.withResolvers()
  const sent = []
  let inferenceStarted = false
  let refreshRequests = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new Request(url, options)
    if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      assert.ok(inferenceStarted, 'Opening the model catalog must not rotate the grant')
      refreshRequests++
      assert.deepEqual(Object.fromEntries(await request.formData()), { grant_type: 'refresh_token',
        client_id: 'first-client', refresh_token: 'old-refresh', resource: 'https://api.openai.com/v1' })
      refresh.resolve()
      await allowRefresh.promise
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
        scope: 'chatgpt.tokens.use.direct offline_access' })
    }
    assert.equal(request.url, 'https://api.openai.com/v1/responses')
    sent.push(request.headers.get('authorization'))
    return Response.json({ error: { message: 'fixture' } }, { status: 403 })
  })
  assert.equal((await adapter.listModels(provider)).length, 1)
  assert.equal((await (await endpoint(endpointRequest())).json()).connected, true)
  assert.equal((await speed(new Request(`http://localhost/api/rumi-chatgpt/speed?sessionId=one&model=${model}`))).status, 200)
  assert.equal(refreshRequests, 0)
  inferenceStarted = true
  const first = send(adapter)
  await Promise.race([refresh.promise, first])
  const second = send(adapter)
  allowRefresh.resolve()
  await Promise.all([first, second])
  assert.equal(refreshRequests, 1)
  assert.deepEqual(sent, ['Bearer new-access', 'Bearer new-access'])
  assert.equal(accountRecord().payload.token.refresh, 'new-refresh')
})

it('retains the grant on an outage and stops using it after an explicit token rejection', async (t) => {
  const { adapter, accountRecord, endpoint } = await mount(expiredGrant)
  let refreshRequests = 0
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token')
    return refreshRequests++ === 0 ? new Response(null, { status: 503 })
      : Response.json({ error: 'invalid_grant' }, { status: 400 })
  })
  await assert.rejects(send(adapter), { code: 'UPSTREAM' })
  assert.deepEqual(accountRecord(), expiredGrant)
  assert.equal((await (await endpoint(endpointRequest())).json()).reauthRequired, false)
  await assert.rejects(send(adapter), { code: 'AUTH', message: /Sign in again/ })
  assert.equal(accountRecord().payload.token, undefined)
  assert.deepEqual(accountRecord().payload.models, planModels)
  const reopened = await mount(accountRecord())
  assert.deepEqual(await (await reopened.endpoint(endpointRequest())).json(), {
    connected: false, reauthRequired: true, pending: false, failed: false,
  })
  await assert.rejects(reopened.adapter.listModels(provider), { code: 'AUTH', message: /Sign in again/ })
  await assert.rejects(send(reopened.adapter), { code: 'AUTH' })
  assert.equal(fetch.mock.callCount(), 2)
})

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

it('replaces a rejected grant through browser sign-in without disconnecting', async (t) => {
  const record = { kind: 'grant', payload: { models: planModels, clientId: 'first-client', reauthRequired: true } }
  const { adapter, endpoint, accountRecord } = await mount(record)
  async function waitForState(ready) {
    for (let i = 0; i < 100; i++) {
      const state = await (await endpoint(endpointRequest())).json()
      assert.equal(state.failed, false)
      if (ready(state)) return state
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('ChatGPT sign-in did not reach the expected state')
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new Request(url, options)
    if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = await request.formData()
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('client_id'), 'replacement-client')
      return Response.json({ access_token: 'replacement-access', refresh_token: 'replacement-refresh',
        id_token: 'fixture', expires_in: 3600, scope: 'chatgpt.tokens.use.direct offline_access' })
    }
    assert.equal(request.url, 'https://api.openai.com/v1/models')
    assert.equal(request.headers.get('authorization'), 'Bearer replacement-access')
    return Response.json({ models: [{ slug: model, display_name: 'Sol from this account', visibility: 'list' }] })
  })
  try {
    await endpoint(endpointRequest('start'))
    await waitForState(state => Boolean(state.url))
    assert.equal((await (await endpoint(endpointRequest('cancel'))).json()).pending, false)
    assert.deepEqual(accountRecord(), record)

    await endpoint(endpointRequest('start'))
    const { url } = await waitForState(state => Boolean(state.url))
    const authorize = new URL(url)
    assert.equal(authorize.hostname, 'auth.openai.com')
    assert.equal(authorize.searchParams.get('agent_name_hint'), 'Rumi')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    const callback = new URL(authorize.searchParams.get('redirect_uri'))
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'browser-code',
      client_id: 'replacement-client' })
    await new Promise((resolve, reject) => {
      get(callback, response => {
        response.resume()
        response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error(`Callback responded ${response.statusCode}`)))
      }).on('error', reject)
    })
    await waitForState(state => state.connected && !state.pending)
    assert.equal(accountRecord().payload.token.refresh, 'replacement-refresh')
    assert.equal(accountRecord().payload.reauthRequired, undefined)
    assert.equal((await adapter.listModels(provider))[0].name, 'Sol from this account')
  } finally {
    await endpoint(endpointRequest('cancel'))
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

it('preserves native OpenAI Responses replay state without degrading assistant history', async () => {
  const { adapter } = await mount({ kind: 'grant', payload: {
    token: { type: 'oauth', access: 'replay-token', expires: Date.now() + 60000 },
    models: [{ id: model, name: 'GPT-6.2 Sol', tiers: ['auto', 'ultrafast'] }],
  } }, { solServiceTier: 'ultrafast' })
  const original = globalThis.fetch
  const bodies = []
  const sse = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_blob_1', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_native_42', call_id: 'call_42', name: 'measure', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_native_42', call_id: 'call_42', name: 'measure', arguments: '{}' } },
    { type: 'response.completed', response: {
      id: 'resp_1', status: 'completed',
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } },
    } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options)
    bodies.push(await request.json())
    return bodies.length === 1
      ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ error: { message: 'stop second call' } }, { status: 403 })
  }
  const tools = [{ name: 'measure', description: 'Measure model', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }]
  let firstFinish
  try {
    for await (const chunk of adapter.stream({
      provider, model, sessionId: 'sess-replay', tools,
      messages: [{ role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Measure it' }] }],
    })) {
      if (chunk.type === 'finish') firstFinish = chunk
    }
    assert.equal(firstFinish?.replayState?.response?.provider, provider)
    const assistant = {
      role: 'assistant', id: 'a1',
      source: { kind: 'model', provider, model, replayState: firstFinish.replayState },
      content: [
        { type: 'reasoning', text: '' },
        { type: 'tool-call', id: 'call_42|fc_native_42', name: 'measure', arguments: '{}' },
      ],
    }
    const toolResult = {
      role: 'tool', id: 't1', toolCallId: 'call_42|fc_native_42',
      source: { kind: 'tool', callId: 'call_42|fc_native_42' },
      content: [{ type: 'text', text: '10mm' }],
    }
    for await (const chunk of adapter.stream({
      provider, model, sessionId: 'sess-replay', tools,
      messages: [
        { role: 'user', id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Measure it' }] },
        assistant,
        toolResult,
      ],
    })) {
      if (chunk.type === 'finish') break
    }
  } finally { globalThis.fetch = original }
  assert.equal(bodies.length, 2)
  const reasoningItem = bodies[1].input.find(item => item.type === 'reasoning')
  const callItem = bodies[1].input.find(item => item.type === 'function_call')
  assert.equal(reasoningItem?.encrypted_content, 'enc_blob_1')
  assert.equal(callItem?.id, 'fc_native_42')
})
