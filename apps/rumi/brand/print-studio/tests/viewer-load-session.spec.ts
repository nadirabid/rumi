/** Rendered load feedback reaches the model through the real tool and session pipeline. */
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
import { assemblyGlb } from './fixtures/assembly-glb.js'
import { parseGlbModel } from '../viewer/viewport/glb.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { generateModule } from '../viewer/generation/export.js'
import { readMotion } from '../viewer/motion.js'
import { analyzeMesh } from '../viewer/checks.js'

class LoadReplay extends LlmAdapter {
  path = 'models/box/model.js'
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

it.each(['javascript', 'glb'])('delivers %s load measurements and movement to the next model request in a keyless session', async (format) => {
  const temporary = await mkdtemp(join(tmpdir(), 'rumi-load-session-'))
  const ctx = new Context(), controller = new AbortController()
  try {
    const root = await realpath(temporary)
    await mkdir(join(root, 'models', 'box'), { recursive: true })
    await writeFile(join(root, 'models', 'box', 'model.js'), 'export const parameters={width:12,angle:0}; export const motionControls=[{kind: "slider",label: "Door",axes:[{key: "angle",min:0,max:90,step:1,reset:0}]}]; export function build(T,p){const m=new T.Mesh(new T.BoxGeometry(p.width,12,2),new T.MeshStandardMaterial());m.rotation.z=p.angle*Math.PI/180;return m}\n')
    if (format === 'glb') await writeFile(join(root, 'models', 'box', 'model.glb'), assemblyGlb())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const harness = await mountAgentLoopTestHarness(ctx)
    const adapter = new LoadReplay()
    if (format === 'glb') adapter.path = 'models/box/model.glb'
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
    const request = async (route: string, body?: object) => {
      const response = await routes.get(`/api/print-studio/viewer/${route}`)!(new Request(
        `http://fixture/api/print-studio/viewer/${route}?sessionId=${sessionId}&after=0`, {
          signal: controller.signal,
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        },
      ))
      expect(response.status).toBe(200)
      return response.json()
    }
    const renderer = (async () => {
      await request('events')
      const { scene } = await request('state')
      const source = await routes.get(scene.design.url)!(new Request(`http://fixture${scene.design.url}`))
      const generated = format === 'javascript'
        ? await generateModule(await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(await source.text())), {})
        : { bytes: await source.arrayBuffer(), parameters: {} }
      const model = await parseGlbModel(generated.bytes)
      let glbFeedback
      try {
        glbFeedback = { parameters: { ...generated.parameters, ...model.parameters },
          motion: readMotion(model.motionDefinitions, model.parameters), report: analyzeMesh(model.positions) }
      } finally { disposeModel(model.root) }
      await request('feedback', {
        revision: scene.design.revision, url: scene.design.url, transform: scene.design.transform,
        volume: scene.volume, loadStatus: 'ready', parameters: { width: 12, angle: 0 },
        motion: { values: { angle: 0 }, controls: [{ kind: 'slider', label: 'Door', axes: [{ key: 'angle', min: 0, max: 90, step: 1, reset: 0 }] }] },
        report: { status: 'ok', dimensions: { x: 12, y: 12, z: 2 }, checks: [] },
        ...glbFeedback,
      })
    })()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Show the example box and its measured size.' }] }))
    await Promise.all([agent.whenIdle(), renderer])
    expect(adapter.requests).toHaveLength(2)
    const toolMessages = adapter.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    const output = toolMessages[0]!.content.find(block => block.type === 'text')
    if (output?.type !== 'text') throw new Error('The next model request lacks the viewer_load result')
    const normalized = output.text.replaceAll(root, '<project>').replace(/\/api\/print-studio\/viewer\/source\/[^/]+/g, '/api/print-studio/viewer/source/<revision>')
    const result = JSON.parse(normalized)
    if (format === 'javascript') expect(result).toMatchObject({ load: { status: 'ready' }, design: {
      parameters: { width: 12, angle: 0 }, report: { dimensions: { x: 12, y: 12, z: 2 } },
    } })
    if (format === 'javascript') expect(result.design).not.toHaveProperty('motion')
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['viewer_load'])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason)).toEqual([{ kind: 'completed' }])
    if (format === 'glb') {
      expect({ load: result.load.status, format: result.design.format,
        motion: result.design.motion, parameters: result.design.parameters }).toMatchSnapshot()
    } else expect(result).toMatchInlineSnapshot(`
      {
        "design": {
          "analog": null,
          "camera": null,
          "contentHash": "b4cfe1e376d36db7d3f8b524f35240b22634b2693f926e8637fd13758345b827",
          "error": null,
          "format": "javascript",
          "highlight": null,
          "parameters": {
            "angle": 0,
            "width": 12,
          },
          "path": "<project>/models/box/model.js",
          "report": {
            "bounds": {
              "max": {
                "x": 6,
                "y": 6,
                "z": 1,
              },
              "min": {
                "x": -6,
                "y": -6,
                "z": -1,
              },
            },
            "checks": [
              {
                "code": "blender_validation",
                "data": {},
                "severity": "pending",
              },
            ],
            "dimensions": {
              "x": 12,
              "y": 12,
              "z": 2,
            },
            "status": "review",
            "suggested": {
              "rotate": false,
              "scale": null,
            },
            "triangleCount": 12,
            "volume": null,
          },
          "revision": 1,
          "transform": {
            "position": {
              "x": 0,
              "y": 0,
              "z": 0,
            },
            "rotate": {
              "x": 0,
              "y": 0,
              "z": 0,
            },
            "scale": 1,
          },
          "url": "/api/print-studio/viewer/source/<revision>/model.js",
        },
        "discoveryError": null,
        "errors": 0,
        "load": {
          "requested": {
            "path": "<project>/models/box/model.js",
            "revision": 1,
            "transform": {
              "position": {
                "x": 0,
                "y": 0,
                "z": 0,
              },
              "rotate": {
                "x": 0,
                "y": 0,
                "z": 0,
              },
              "scale": 1,
            },
            "url": "/api/print-studio/viewer/source/<revision>/model.js",
            "volume": null,
          },
          "status": "ready",
        },
        "models": [
          {
            "name": "box",
            "path": "models/box/model.js",
          },
        ],
        "objectCount": 0,
        "objects": [],
        "selectedModel": "models/box/model.js",
        "status": "review",
        "volume": null,
        "warnings": 0,
      }
    `)
  } finally {
    controller.abort()
    await ctx.fiber.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
})
