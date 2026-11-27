/** Local ChatGPT plan login and account-scoped Responses models. */
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

/** Processing tier and request limits for the ChatGPT account route. */
export const Config = z.object({
  solServiceTier: z.enum(['auto', 'ultrafast']).default('auto'),
  streamIdleTimeoutMs: z.int().positive().max(2_147_483_647).default(120_000),
  maxRequestImageBytes: z.int().min(4).default(32_000_000),
  maxRequestImages: z.int().positive().default(20),
  requestImagePixelBudget: z.int().positive().default(2_000_000),
  requestImageMaxBytes: z.int().positive().default(2_000_000),
}).refine(config => config.maxRequestImageBytes >= 4 * config.maxRequestImages, {
  message: 'The ChatGPT image byte budget must allow four base64 bytes per image.',
  path: ['maxRequestImageBytes'],
})
export const inject = ['connection', 'credentials', 'llm', 'storageDomain']
const route = 'rumi-chatgpt'
const account = credentialKey(route, 'account')
const install = credentialKey(route, 'installation')

const tierSchema = z.enum(['auto', 'priority', 'ultrafast'])
const speedPreferences = defineDomain({ name: 'rumi_model_speed', version: 1,
  tables: { selections: domainTable(z.object({ requested: tierSchema })) } })
const address = z.object({ sessionId: z.string().min(1).max(200), model: z.string().min(1).max(200) })
const refreshedGrant = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(), scope: z.string() })
const unusableRefreshCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])

/** Return a replacement token set, or undefined when OpenAI requires a new authorization. */
async function refreshGrant(token) {
  if (!token.clientId || !token.refresh) return undefined
  let response
  try {
    response = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: token.clientId,
        refresh_token: token.refresh, resource: 'https://api.openai.com/v1' }),
    })
  } catch (cause) {
    throw new LlmError('Could not renew the ChatGPT sign-in. Try again.', 'NETWORK', { cause })
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && unusableRefreshCodes.has(code)) return undefined
    const failure = response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'UPSTREAM' : 'AUTH'
    throw new LlmError('Could not renew the ChatGPT sign-in. Try again.', failure, { status: response.status })
  }
  const parsed = refreshedGrant.safeParse(body)
  if (!parsed.success) throw new LlmError('ChatGPT returned an incomplete sign-in renewal. Try again.', 'INVALID_RESPONSE')
  const scopes = parsed.data.scope.split(/\s+/)
  if (!scopes.includes('chatgpt.tokens.use.direct')) return undefined
  return { type: 'oauth', clientId: token.clientId, access: parsed.data.access_token, refresh: parsed.data.refresh_token,
    expires: Date.now() + parsed.data.expires_in * 1000 - 180000, scopes }
}

function signInRequired() {
  return new LlmError('Sign in again to your ChatGPT plan in Settings → Models.', 'AUTH')
}

function registration(record) {
  return record?.payload?.token?.clientId ?? record?.payload?.clientId ?? undefined
}

async function accountCatalog(accessToken, models, signal) {
  const response = await fetch('https://api.openai.com/v1/models', { signal, redirect: 'error',
    headers: { Authorization: 'Bearer ' + accessToken } })
  if (!response.ok) throw new Error('ChatGPT model discovery failed')
  const catalog = (await response.json()).models.filter(item => item.visibility === 'list' &&
    (item.slug === 'gpt-6.2-sol' || models.some(m => m.id === item.slug && m.api === 'openai-responses')))
    .map(item => ({ id: item.slug, name: item.display_name, tiers: ['auto', ...new Set(
      (item.service_tiers ?? []).map(tier => tier.id).filter(id => id === 'priority' || id === 'ultrafast'))] }))
  if (!catalog.length) throw new Error('No compatible ChatGPT models')
  return catalog
}

function rebrandContext(context, fromProvider, toProvider) {
  if (!Array.isArray(context?.messages)) return context
  let changed = false
  const messages = context.messages.map(message => {
    if (message?.role !== 'assistant' || message.provider !== fromProvider) return message
    changed = true
    return { ...message, provider: toProvider }
  })
  return changed ? { ...context, messages } : context
}

function rebrandEvent(event, provider) {
  if (!event || typeof event !== 'object') return event
  if (event.type === 'done' && event.message) return { ...event, message: { ...event.message, provider } }
  if (event.type === 'error' && event.error) return { ...event, error: { ...event.error, provider } }
  if (event.partial) return { ...event, partial: { ...event.partial, provider } }
  return event
}

function rebrandStream(stream, provider) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) yield rebrandEvent(event, provider)
    },
    result: typeof stream?.result === 'function'
      ? async () => ({ ...(await stream.result()), provider })
      : undefined,
  }
}

/** Mount the provider and its local settings actions. */
export async function apply(ctx, config) {
  const native = openaiProvider()
  const oauth = native.auth.oauth
  const models = native.getModels()
  const sol = models.find(m => m.id === 'gpt-6.1-sol')
  const domain = await ctx.storageDomain.open(speedPreferences)
  ctx.effect(() => () => domain.close())
  const preferences = domain.table('selections')
  const keyFor = (sessionId, model) => createHash('sha256').update(JSON.stringify([sessionId, model])).digest('hex')
  function requested(sessionId, model, tiers) {
    const saved = sessionId && preferences.get(keyFor(sessionId, model))?.requested
    const tier = saved || (model === 'gpt-6.2-sol' ? config.solServiceTier : 'auto')
    return !tiers || tiers.includes(tier) ? tier : 'auto'
  }
  let attempt
  let failed = false
  let choices = []
  const provider = {
    id: route, name: 'ChatGPT plan', auth: { apiKey: { name: 'ChatGPT access token', async resolve({ credential }) {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: 'ChatGPT plan' }
    } } },
    getModels: () => choices,
    streamSimple: (model, context, options) => rebrandStream(
      native.streamSimple({ ...model, provider: 'openai' }, rebrandContext(context, route, 'openai'), {
        ...options, onPayload(payload) {
          const tier = requested(options.sessionId, model.id, choices.find(item => item.id === model.id)?.tiers)
          if (tier !== 'auto') payload.service_tier = tier
          if (payload.tools?.length) {
            payload.input.unshift({ type: 'additional_tools', role: 'developer', tools: payload.tools })
            delete payload.tools
          }
          return payload
        },
      }),
      route,
    ),
  }
  function grant(record) {
    if (record?.payload?.reauthRequired) throw signInRequired()
    if (record?.payload?.token?.type !== 'oauth' || !record.payload.token.access)
      throw new LlmError('Sign in to your ChatGPT plan in Models.', 'MISSING_CREDENTIAL')
    return record.payload.token
  }
  async function access() {
    let record = await ctx.credentials.readRecord(account)
    if (grant(record).expires <= Date.now()) {
      record = await ctx.credentials.modifyRecord(account, async current => {
        const token = grant(current)
        if (token.expires > Date.now()) return undefined
        const refreshed = await refreshGrant(token)
        return { kind: 'grant', payload: refreshed ? { ...current.payload, token: refreshed }
          : { models: current.payload.models, clientId: token.clientId ?? null, reauthRequired: true } }
      })
    }
    restoreModels(record)
    return grant(record).access
  }
  function restoreModels(record) {
    choices = (record?.payload?.models ?? []).map(item => {
      const template = models.find(m => m.id === item.id) ?? sol
      return { ...template, provider: route, id: item.id, name: item.name, tiers: item.tiers,
        compat: { ...template.compat, supportsToolSearch: false } }
    })
  }
  restoreModels(await ctx.credentials.readRecord(account))
  const profiles = new Map([[route, {
    provider: route, displayName: provider.name, piProvider: provider,
    modelErrors: new Map(), configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes,
    maxRequestImages: config.maxRequestImages,
    imageOffloadCountQuantum: 1,
    requestImageBudgetCount: config.maxRequestImages,
    requestImagePixelBudget: config.requestImagePixelBudget,
    maxImageBytes: config.requestImageMaxBytes,
    retryPolicy: resolveRetryPolicy(undefined, `${route}.retryPolicy`),
  }]])
  class ChatGPTAdapter extends PiAiAdapter {
    /** The saved catalog can be read without rotating the inference credential. */
    async listModels(providerId) {
      if (providerId !== route) return super.listModels(providerId)
      const record = await ctx.credentials.readRecord(account)
      if (!record) return []
      grant(record)
      restoreModels(record)
      return choices.map(model => ({ provider: route, id: model.id, name: model.name, inputModalities: [...model.input] }))
    }
  }
  ctx.llm.registerAdapter([route], new ChatGPTAdapter({ profiles: () => profiles, auth: {}, resolveApiKey: access,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref) }))
  async function login(active) {
    const identity = await ctx.credentials.modifyRecord(install, async previous => previous ?? { kind: 'grant', payload: { id: randomUUID() } })
    const previous = await ctx.credentials.readRecord(account)
    const signal = active.controller.signal
    signal.throwIfAborted()
    const token = await oauth.login({ signal,
      notify(event) { if (event.type === 'auth_url') active.url = event.url },
      prompt(prompt) { return new Promise((_, reject) => {
        const abort = () => reject(new Error('Sign-in ended'))
        if (prompt.signal.aborted) abort()
        else prompt.signal.addEventListener('abort', abort, { once: true })
      }) },
    }, { getDeviceId: () => identity.payload.id, agentName: 'Rumi' })
    const catalog = await accountCatalog(token.access, models, AbortSignal.any([signal, AbortSignal.timeout(15000)]))
    const saved = await ctx.credentials.modifyRecord(account, async current => {
      signal.throwIfAborted()
      if (registration(current) !== registration(previous)) throw new Error('ChatGPT connection changed during sign-in')
      return { kind: 'grant', payload: { token, models: catalog } }
    })
    restoreModels(saved)
  }
  ctx.effect(() => async () => { attempt?.controller.abort(); await attempt?.done })
  // Earlier grants stored model names only. Refresh their catalog once without a new login.
  async function tiersFor(model) {
    let record = await ctx.credentials.readRecord(account)
    const token = grant(record)
    if (record.payload.models.some(item => !item.tiers)) {
      if (token.expires <= Date.now()) return undefined
      const bearer = token.access
      const catalog = await accountCatalog(bearer, models, AbortSignal.timeout(15000))
      record = await ctx.credentials.modifyRecord(account, async current => {
        if (grant(current).access !== bearer) throw new Error('ChatGPT account changed')
        return { ...current, payload: { ...current.payload, models: catalog } }
      })
      restoreModels(record)
    }
    return record.payload.models.find(item => item.id === model)?.tiers
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/rumi-chatgpt/speed', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      const write = request.method === 'POST'
      if (write && request.headers.get('x-rumi-settings') !== '1') return new Response(null, { status: 403 })
      const parsed = write ? address.extend({ tier: tierSchema }).safeParse(await request.json().catch(() => null))
        : address.safeParse(Object.fromEntries(new URL(request.url).searchParams))
      if (!parsed.success) return new Response(null, { status: 400 })
      const { sessionId, model, tier } = parsed.data
      try {
        const tiers = await tiersFor(model)
        if (!tiers || (write && !tiers.includes(tier))) return new Response(null, { status: 422 })
        if (write) await preferences.put(keyFor(sessionId, model), { requested: tier })
        return Response.json({ tiers, requested: requested(sessionId, model, tiers) }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) {
        return new Response(null, { status: error.code === 'MISSING_CREDENTIAL' || error.code === 'AUTH' ? 401 : 503 })
      }
    } }))
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/rumi-chatgpt', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'POST') {
        if (request.headers.get('x-rumi-settings') !== '1') return new Response(null, { status: 403 })
        const { action } = await request.json()
        if (action === 'start' && !attempt) {
          failed = false
          const active = { controller: new AbortController() }
          attempt = active
          active.done = login(active).catch(() => { failed = !active.controller.signal.aborted }).finally(() => { attempt = undefined })
        } else if (action === 'disconnect' || action === 'cancel') {
          attempt?.controller.abort()
          await attempt?.done
          if (action === 'disconnect') { await ctx.credentials.deleteRecord(account); choices = [] }
          failed = false
        }
      }
      const record = await ctx.credentials.readRecord(account)
      const reauthRequired = record?.payload?.reauthRequired === true
      return Response.json({ connected: Boolean(record?.payload?.token?.access), reauthRequired, pending: Boolean(attempt),
        url: attempt?.url, failed }, { headers: { 'Cache-Control': 'no-store' } })
    } }))
}
