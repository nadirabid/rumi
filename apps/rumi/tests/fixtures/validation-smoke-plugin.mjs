/** Exercise shipped tool registration, project guards, snapshot storage and real engines together. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Deterministic model calls exercise the production turn driver without external credentials. */
class ValidationScript extends LlmAdapter {
  calls = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    // Background title requests have no tools and must not consume the turn script.
    const call = options.tools?.length ? this.calls.shift() : undefined
    if (call) {
      assert(options.tools.some(tool => tool.name === call.name), `Missing model-visible tool: ${call.name}`)
      const id = ToolCallId(randomUUID()), args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = 'The saved test revisions passed validation.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Register a private smoke route in the temporary packaging profile.
 * @param {object} ctx Composed production Host context.
 * @param {object} config Private fixture paths; an optional copied model is diagnostic only.
 */
export function applyValidationSmoke(ctx, config) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-validation',
    async handler(_request, response) {
      let handle, releaseAdapter
      try {
        const id = randomUUID(), sessionId = SessionId(randomUUID())
        const root = join(ctx.rumiProjectScope.workspaceRoot, id)
        await mkdir(join(root, 'models'), { recursive: true })
        await writeFile(join(root, 'project.json'), JSON.stringify({ id, name: 'Validation smoke', type: 'print', sessionIds: [sessionId] }))
        for (const model of ['solid', 'wheel']) await cp(join(config.fixtures, model), join(root, 'models', model), { recursive: true })
        if (config.extraModel) {
          await mkdir(join(root, 'models/diagnostic'))
          await cp(config.extraModel, join(root, 'models/diagnostic/model.usda'))
        }
        const adapter = new ValidationScript()
        releaseAdapter = ctx.effect(() => ctx.llm.registerAdapter(['validation-smoke'], adapter))
        handle = await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: { provider: 'validation-smoke', model: 'scripted' } })
        let call = 0
        const invoke = async (stage, args = {}) => {
          const result = await ctx.tools.execute({ name: `validation_${stage}`, arguments: args, agent: handle.agent,
            callId: ToolCallId(`validation-smoke-${++call}`), signal: AbortSignal.timeout(720000) })
          assert.equal(result.isError, false, JSON.stringify(result.content))
          const text = result.content.find(block => block.type === 'text')
          assert(text, 'Validation must return a text report')
          return JSON.parse(text.text)
        }
        const paths = ['solid', 'wheel', ...(config.extraModel ? ['diagnostic'] : [])].map(name => `models/${name}/model.usda`)
        const outcomes = [], receipts = new Map()
        for (const path of paths) {
          const reports = []
          for (const stage of ['mechanics', 'accept']) {
            const started = performance.now()
            const result = await invoke(stage, stage === 'mechanics' ? { path } : { path, fingerprint: receipts.get(path) })
            if (stage === 'mechanics') receipts.set(path, result.fingerprint)
            reports.push({ stage, status: result.status, durationMs: Math.round(performance.now() - started),
              checks: result.report?.checks ?? result.checks ?? [], code: result.code })
            console.log('validation smoke:', path, stage, result.status)
            if (path.includes('/diagnostic/') && ['needs_repair', 'blocked', 'unavailable'].includes(result.status)) break
            assert.notEqual(result.status, 'blocked', JSON.stringify(result))
            assert.notEqual(result.status, 'needs_repair', JSON.stringify(result))
            if (stage === 'mechanics') {
              assert.equal(result.report.assemblyVerified, true)
              assert.equal(result.report.coverage.complete, true)
              const cached = await invoke(stage, { path })
              assert.equal(cached.cached, true)
            }
            if (stage === 'accept') assert.equal(result.status, 'accepted')
          }
          outcomes.push({ path, reports })
        }
        adapter.calls = paths.filter(path => !path.includes('/diagnostic/'))
          .flatMap(path => [{ name: 'validation_mechanics', args: { path } },
            { name: 'validation_accept', args: { path, fingerprint: receipts.get(path) } }])
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Validate the saved test models.' }] }))
        await handle.agent.whenIdle()
        const events = handle.agent.session.snapshotEvents()
        const results = events.filter(event => event.type === 'tool/result')
        assert.equal(results.length, 4, JSON.stringify(events.filter(event => ['turn/end', 'tool/result'].includes(event.type))))
        assert(results.every(event => !event.data.message.isError), JSON.stringify(results))
        const recorded = results.map(event => JSON.parse(event.data.message.content.find(block => block.type === 'text').text))
        assert(recorded.every(result => ['passed', 'review', 'accepted'].includes(result.status)))
        assert.equal(recorded.filter(result => result.status === 'accepted').length, 2)
        assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
        assert.equal(events.some(event => event.type === 'user/message' && event.data.source.kind === 'print-validation'), false)
        console.log('validation smoke: four tool calls completed within one recorded turn')
        const denied = await ctx.tools.execute({ name: 'validation_mechanics', arguments: { path: '../outside/model.usda' },
          agent: handle.agent, callId: ToolCallId('validation-smoke-denied'), signal: AbortSignal.timeout(10000) })
        assert.equal(denied.isError, true)
        assert(JSON.stringify(denied.content).includes('Project isolation denied access'))
        const solid = 'models/solid/model.usda'
        await writeFile(join(root, solid), '#usda 1.0\n# Changed after checking\n')
        assert.equal((await invoke('accept', { path: solid, fingerprint: receipts.get(solid) })).code, 'stale_revision')
        response.end(JSON.stringify({ status: 'passed', outcomes, crossProjectDenied: true, staleRevisionRejected: true, recordedToolCalls: results.length, turns: 1 }))
      } catch (error) { response.statusCode = 500; response.end(String(error.stack ?? error)) }
      finally { await handle?.dispose(); await releaseAdapter?.() }
    },
  }))
}
