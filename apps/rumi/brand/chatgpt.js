/** Local ChatGPT plan login and account-scoped Responses models. */
import { randomUUID } from 'node:crypto'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

export const inject = ['connection', 'credentials', 'llm']
const route = 'rumi-chatgpt'
const account = credentialKey(route, 'account')
const install = credentialKey(route, 'installation')

/** Mount the provider and its local settings actions. */
export async function apply(ctx) {
  const native = openaiProvider()
  const oauth = native.auth.oauth
  const models = native.getModels()
  const sol = models.find(m => m.id === 'gpt-6.1-sol')
  let attempt
  let failed = false
  let choices = []
  const provider = {
    id: route, name: 'ChatGPT plan', auth: { apiKey: { name: 'ChatGPT access token', async resolve({ credential }) {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: 'ChatGPT plan' }
    } } },
    getModels: () => choices,
    streamSimple: (model, context, options) => native.streamSimple({ ...model, provider: 'openai' }, context, {
      ...options, onPayload(payload) {
        if (payload.tools?.length) {
          payload.input.unshift({ type: 'additional_tools', role: 'developer', tools: payload.tools })
          delete payload.tools
        }
        return payload
      },
    }),
  }
  function grant(record) {
    if (record?.payload?.token?.type !== 'oauth' || !record.payload.token.access)
      throw new LlmError('Sign in to your ChatGPT plan in Models.', 'MISSING_CREDENTIAL')
    return record.payload.token
  }
  async function access() {
    let record = await ctx.credentials.readRecord(account)
    if (grant(record).expires <= Date.now()) {
      record = await ctx.credentials.modifyRecord(account, async current => {
        const token = grant(current)
        if (token.expires > Date.now()) return current
        return { kind: 'grant', payload: { ...current.payload, token: await oauth.refresh(token, AbortSignal.timeout(15000)) } }
      })
    }
    restoreModels(record)
    return grant(record).access
  }
  function restoreModels(record) {
    choices = record.payload.models.map(item => {
      const template = models.find(m => m.id === item.id) ?? sol
      return { ...template, provider: route, id: item.id, name: item.name,
        compat: { ...template.compat, supportsToolSearch: false } }
    })
  }
  const saved = await ctx.credentials.readRecord(account)
  if (saved) restoreModels(saved)
  const profiles = new Map([[route, { provider: route, displayName: provider.name, piProvider: provider,
    modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 120000,
    maxRequestImageBytes: 32000000, requestImagePixelBudget: 2000000, requestImageMaxBytes: 2000000 }]])
  ctx.llm.registerAdapter([route], new PiAiAdapter({ profiles: () => profiles, auth: {}, resolveApiKey: access,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref) }))
  async function login(active) {
    const identity = await ctx.credentials.modifyRecord(install, async previous => previous ?? { kind: 'grant', payload: { id: randomUUID() } })
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
    const response = await fetch('https://api.openai.com/v1/models', { signal, redirect: 'error', headers: { Authorization: 'Bearer ' + token.access } })
    if (!response.ok) throw new Error('ChatGPT model discovery failed')
    const catalog = (await response.json()).models.filter(item => item.visibility === 'list' &&
      (item.slug === 'gpt-6.2-sol' || models.some(m => m.id === item.slug && m.api === 'openai-responses')))
      .map(item => ({ id: item.slug, name: item.display_name }))
    if (!catalog.length) throw new Error('No compatible ChatGPT models')
    await ctx.credentials.modifyRecord(account, async () => {
      signal.throwIfAborted()
      return { kind: 'grant', payload: { token, models: catalog } }
    })
  }
  ctx.effect(() => () => attempt?.controller.abort())
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
      return Response.json({ connected: Boolean(await ctx.credentials.readRecord(account)), pending: Boolean(attempt),
        url: attempt?.url, failed }, { headers: { 'Cache-Control': 'no-store' } })
    } }))
}
