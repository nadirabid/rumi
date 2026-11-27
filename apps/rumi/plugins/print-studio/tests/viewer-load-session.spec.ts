/** Rendered load feedback reaches the model through the real tool and session pipeline. */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createPrintLayoutPanel } from '../viewer/print-layout/panel.js'
import { en } from '../viewer/locales.js'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyViewer } from '../viewer/host.js'
import { robotUsd } from './fixtures/robot-usd.js'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { readMotion } from '../viewer/motion.js'
import { printParts, arrangePrintParts, layoutIssues } from '../viewer/viewport/print-layout.js'
import { analyzeMesh } from '../viewer/checks.js'

class LoadReplay extends LlmAdapter {
  path = 'models/box/model.usda'
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const id = ToolCallId('fixture-load')
      const args = JSON.stringify({ path: this.path })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'viewer_load', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'viewer_load', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      if (this.requests.length !== 2) throw new Error('Unexpected model request after the load result')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The box is visible: 12 × 12 × 2 mm.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it.each(['usd'])('delivers %s load measurements and movement to the next model request in a keyless session', async (format) => {
  const temporary = await mkdtemp(join(tmpdir(), 'rumi-load-session-'))
  const ctx = new Context(), controller = new AbortController()
  let renderer: Promise<void> | undefined
  try {
    const root = await realpath(temporary)
    await mkdir(join(root, 'models', 'box'), { recursive: true })
    if (format === 'usd') await writeFile(join(root, 'models', 'box', 'model.usda'), robotUsd())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new LoadReplay()
    if (format === 'usd') adapter.path = 'models/box/model.usda'
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], adapter))
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    applyViewer({
      on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx), inject: ctx.inject.bind(ctx),
      tools: ctx.tools, fs: ctx.fs, workingDirectory: ctx.workingDirectory,
      sessionQuery: { observeSession: async () => ({ header: { cwd: root }, [Symbol.dispose]() {} }) },
      connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      } } },
    }, defineTool, join(root, 'diagnostics'), 8000)
    const sessionId = SessionId('viewer-load-session')
    const agent = await harness.create(sessionId, { provider: 'fixture', model: 'fixture' }, { cwd: root })
    let cursor = 0
    const request = async (route: string, body?: object) => {
      const response = await routes.get(`/api/print-studio/viewer/${route}`)!(new Request(
        `http://fixture/api/print-studio/viewer/${route}?sessionId=${sessionId}&after=${cursor}`, {
          signal: controller.signal,
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        },
      ))
      expect(response.status).toBe(200)
      const result = await response.json()
      if (route === 'events') cursor = result.version
      return result
    }
    let printPreparation
    renderer = (async () => {
      let delivered = ''
      while (!controller.signal.aborted) {
        await request('events')
        const { scene } = await request('state')
        if (!scene.design) continue
        const identity = JSON.stringify([scene.design.url, scene.design.renderRequest])
        if (delivered === identity) continue
        delivered = identity
        const source = await routes.get(scene.design.url)!(new Request(`http://fixture${scene.design.url}`))
        const generated = { bytes: await source.arrayBuffer(), parameters: {} }
        const model = await parseUsdModel(generated.bytes)
        const parts = printParts(model)
        const layout = arrangePrintParts(parts, { identity: 'recorded-model', volume: { x: 300, y: 320, z: 320 }, gap: 5 })
        printPreparation = { manufacturingMode: model.robot.assembly.manufacturing.mode,
          parts: parts.map(part => part.id), layout, issues: layoutIssues(parts, layout) }
        const Panel = createPrintLayoutPanel(React, { Button, Menu, IconChevronDownOutlineRegular })
        const controls = renderToStaticMarkup(React.createElement(Panel, {
          state: { ...printPreparation, active: true, plate: 0, selected: parts[0].id,
            parts: parts.map(part => ({ id: part.id, name: part.name })), canUndo: false },
          available: true, busy: false, message: null, action: () => {},
          t: (key: keyof typeof en, values: Record<string, string | number> = {}) =>
            en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name])),
        })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        printPreparation = { ...printPreparation, controls }
        let glbFeedback
        try {
          glbFeedback = { parameters: { ...generated.parameters, ...model.parameters },
            motion: readMotion(model.motionDefinitions, model.parameters), report: analyzeMesh(model.positions) }
        } finally { disposeModel(model.root) }
        await request('feedback', {
          revision: scene.design.revision, url: scene.design.url, renderRequest: scene.design.renderRequest,
          transform: scene.design.transform,
          volume: scene.volume, loadStatus: 'ready', parameters: { width: 12, angle: 0 },
          motion: { values: { angle: 0 }, controls: [{ kind: 'slider', label: 'Door', axes: [{ key: 'angle', min: 0, max: 90, step: 1, reset: 0 }] }] },
          report: { status: 'ok', dimensions: { x: 12, y: 12, z: 2 }, checks: [] },
          ...glbFeedback,
        })
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error })
    void renderer.catch((_error) => { /* The normal path awaits failure; teardown drains after cancellation. */ })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the example box and its measured size.' }] }))
    await agent.whenIdle()
    controller.abort()
    await renderer
    expect(adapter.requests).toHaveLength(2)
    const toolMessages = adapter.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    const output = toolMessages[0]!.content.find(block => block.type === 'text')
    if (output?.type !== 'text') throw new Error('The next model request lacks the viewer_load result')
    const normalized = output.text.replaceAll(root, '<project>').replace(/\/api\/print-studio\/viewer\/source\/[^/]+/g, '/api/print-studio/viewer/source/<revision>')
    const result = JSON.parse(normalized)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['viewer_load'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
    if (format === 'usd') {
      expect({ load: result.load.status, format: result.design.format,
        motion: result.design.motion, parameters: result.design.parameters, printPreparation }).toMatchSnapshot()
    }
  } finally {
    controller.abort()
    await Promise.allSettled(renderer ? [renderer] : [])
    await ctx.fiber.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})
