/** Model references follow admitted input; declared work follows agent lifetime. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { createModelFocus } from '../viewer/model-focus.js'

async function fixture() {
  const owner = new Context()
  await owner.plugin(SystemPrompt)
  // Event payloads exercise the JavaScript plugin without constructing an LLM driver.
  const listeners = new Map<string, (event: any) => void>()
  const record = { selectedModel: 'models/cup/model.glb', models: [{ name: 'cup', path: 'models/cup/model.glb' }],
    source: { state: () => ({ revision: 2 }) } }
  const notices: string[] = []
  const focus = createModelFocus({ effect: owner.effect.bind(owner), inject: owner.inject.bind(owner),
    on: (name: string, listener: (event: any) => void) => { listeners.set(name, listener) },
  }, { read: (id: string) => id === 'one' ? record : undefined, notify: (id: string) => notices.push(id) })
  const agent = { session: { id: 'one' }, status: 'running' } as Agent
  const message = (id: string) => ({ id, source: { kind: 'user' } })
  return { owner, record, focus, agent, notices, message,
    emit: (name: string, payload: object) => listeners.get(name)!({ agent, ...payload }),
    context: async (target = agent) => renderContextSections(await owner.systemPrompt.assemble({ agent: target })),
  }
}

it('keeps admitted references while browsing changes, with separate agent work and recorded context', async () => {
  const f = await fixture()
  try {
    const message = f.message('request-one')
    f.emit('agent/inbox/inserted', { message })
    f.record.selectedModel = 'models/dragon/model.glb'
    f.emit('agent/inbox/claimed', { message, turn: 1 })
    f.focus.set(f.agent, 'models/cup/model.glb')
    expect(f.focus.paths('one')).toEqual(['models/cup/model.glb'])
    const context = await f.context()
    expect(context).toMatchSnapshot()
    expect(renderPrompt(await f.owner.systemPrompt.assemble())).toMatchSnapshot()
    const data = JSON.parse(context.find(section => section.name === 'rumi:model-focus')!.text).modelFocus
    expect(data.currentSelection.path).toBe('models/dragon/model.glb')
    expect(data.requests[0].selectionAtAdmission.path).toBe('models/cup/model.glb')
    expect(data.workingModel).toBe('models/cup/model.glb')
    f.focus.set(f.agent, null)
    expect(f.focus.paths('one')).toEqual([])
  } finally { await f.owner.fiber.dispose() }
})

it('isolates agents, keeps each queued reference, and clears stopped or disposed work', async () => {
  const f = await fixture()
  try {
    const other = { session: { id: 'two' }, status: 'running' } as Agent
    const first = f.message('first'), second = f.message('second')
    f.emit('agent/inbox/inserted', { message: first })
    f.record.selectedModel = 'models/dragon/model.glb'
    f.emit('agent/inbox/inserted', { message: second })
    f.emit('agent/inbox/claimed', { message: first, turn: 1 })
    f.emit('agent/inbox/claimed', { message: second, turn: 1 })
    const context = JSON.parse((await f.context())[0]!.text).modelFocus
    expect(context.requests.map((item: { selectionAtAdmission: { path: string } }) => item.selectionAtAdmission.path))
      .toEqual(['models/cup/model.glb', 'models/dragon/model.glb'])
    f.focus.set(f.agent, 'models/cup/model.glb'); f.focus.set(other, 'models/other/model.glb')
    f.emit('agent/status', { status: 'idle' })
    expect(f.focus.paths('one')).toEqual([])
    expect(f.focus.paths('two')).toEqual(['models/other/model.glb'])
    f.emit('agent/disposed', { agent: other })
    expect(f.focus.paths('two')).toEqual([])
    await f.owner.fiber.dispose()
    expect(f.focus.paths('one')).toEqual([])
    expect(f.focus.paths('two')).toEqual([])
  } finally { await f.owner.fiber.dispose() }
})

it('does not substitute current selection for recovered or discarded input', async () => {
  const f = await fixture()
  try {
    const message = f.message('discarded')
    f.emit('agent/inbox/inserted', { message })
    f.emit('agent/inbox/discarded', { message })
    f.emit('agent/inbox/claimed', { message, turn: 2 })
    const context = JSON.parse((await f.context())[0]!.text).modelFocus
    expect(context.requests).toEqual([{ messageId: 'discarded', selectionAtAdmission: null }])
    expect(() => f.focus.set({ session: { id: 'one' }, status: 'idle' }, 'models/cup/model.glb')).toThrow(/running/u)
  } finally { await f.owner.fiber.dispose() }
})
