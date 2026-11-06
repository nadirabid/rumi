/** Live-model decisions exercise the shipped guidance and real host tools in disposable projects. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const runFile = promisify(execFile)
const blender = '/Applications/Rumi.app/Contents/Resources/runtime/blender/blender'
import { expect, it } from 'vitest'
import { applyViewer } from '../viewer/host.js'
import * as workflow from '../viewer/analog/workflow.js'

const enabled = process.env.RUMI_CONTROLS_REAL_MODEL === '1'
const cases = [
  { name: 'Blender unmarked preview', prompt: 'Let me adjust the width of the box. Keep its other dimensions.', values: { width: 80 }, operation: 'parameters', kind: 'slider', finish: 'That looks good. Keep it.' },
  { name: 'Blender width preview', prompt: 'Let me adjust the width of the box. Keep its other dimensions.', values: { width: 80 }, operation: 'parameters', kind: 'slider', finish: 'That looks good. Keep it.' },
  { name: 'both eyes', prompt: 'The eyes are tilted too sharply. Let me tilt both eyes.', values: { eyeTilt: 10, eyeWidth: 24, eyeHeight: 9 }, operation: 'parameters', kind: 'slider', finish: 'That looks good. Keep it.' },
  { name: 'table width', prompt: 'Let me adjust how wide the table is.', values: { width: 80 }, operation: 'parameters', kind: 'slider', finish: 'Cancel that adjustment.' },
  { name: 'feature position', prompt: 'Give me a two-axis pad to move the feature left-right and up-down.', values: { featureX: 0, featureZ: 0 }, operation: 'parameters', kind: 'pad' },
  { name: 'cut height and tilt', prompt: 'Let me move the bottom cut up and tilt it in both directions.', values: {}, operation: 'cut', kind: 'slider' },
  { name: 'bulge and softness', prompt: 'Let me explore how round the front is, with a softness curve and a position pad.', values: {}, operation: 'bulge', kind: 'curve' },
  { name: 'fixed eye dimensions', prompt: 'Let me tilt both eyes together. Keep their width and height fixed.', values: { eyeTilt: 10, eyeWidth: 24, eyeHeight: 9 }, operation: 'parameters', kind: 'slider' },
]

it.skipIf(!enabled).each(cases)('agent opens and uses generic controls: $name', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-controls-agent-')), ctx = new Context()
  // Host entrypoints are shipped JavaScript; this fixture observes their dynamic definitions and payloads.
  const raw = new Map<string, any>(), routes = new Map<string, any>(), calls: { name: string; args: any }[] = []
  const signal = new AbortController().signal
  const sessionId = SessionId('controls-eval')
  let sequence = 0, frozenRecipe: any, markerAtOpen = false
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    if (process.env.RUMI_EVAL_CREDENTIAL_FILE) {
      await ctx.plugin(LocalCredentials, { path: process.env.RUMI_EVAL_CREDENTIAL_FILE, watch: false })
    }
    await ctx.plugin(DeepSeek, { maxTokens: 4096 })
    const state = async () => (await (await routes.get('/api/print-studio/viewer/state')(
      new Request(`http://fixture/api/print-studio/viewer/state?sessionId=${sessionId}`))).json()).scene
    const feedback = async (body: object) => routes.get('/api/print-studio/viewer/shape-feedback')(
      new Request(`http://fixture/api/print-studio/viewer/shape-feedback?sessionId=${sessionId}`, { method: 'POST', body: JSON.stringify(body) }))
    const facade = {
      on: ctx.on.bind(ctx), effect: ctx.effect.bind(ctx), inject: ctx.inject.bind(ctx),
      connection: { fetch: { register(route: any) { routes.set(route.path, route.fetch); return () => routes.delete(route.path) } } },
      workingDirectory: { ensure: async () => root },
      sessionQuery: { observeSession: async () => ({ header: { cwd: root }, [Symbol.dispose]() {} }) },
      fs: {
        resolve: async (path: string) => ({ path: resolve(root, path), displayPath: path }),
        readBytes: (target: { path: string }) => readFile(target.path),
      },
      tools: { register(tool: any) {
        raw.set(tool.name, tool)
        if (!['viewer_controls', 'viewer_working_model', 'viewer_load'].includes(tool.name)) return () => {}
        return ctx.tools.register({ ...tool, async execute(args: any, exec: any) {
          calls.push({ name: tool.name, args })
          if (tool.name !== 'viewer_controls' || !['open', 'freeze'].includes(args.action)) return tool.execute(args, exec)
          if (args.action === 'open' && scenario.name.startsWith('Blender ')) {
            try { await readFile(join(root, 'models', 'example', '.rumi-preview.json')); markerAtOpen = true }
            catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
          }
          const prior = (await state()).design?.analog?.id
          const pending = tool.execute(args, exec).then((result: string) => {
            if (args.action === 'freeze') frozenRecipe = JSON.parse(result).recipe
            console.log('Controls tool result', scenario.name, result)
            return result
          }, (error: Error) => {
            console.log('Controls tool failure', scenario.name, JSON.stringify(args), error.message)
            throw error
          })
          const acknowledgment = (async () => {
            for (let tries = 0; tries < 100; tries++) {
              const design = (await state()).design, spec = design?.analog
              if (spec && (args.action === 'open' ? spec.id !== prior : spec.freezeRequested)) {
                const response = await feedback({ id: spec.id, url: design.url, status: args.action === 'freeze' ? 'frozen' : 'rendered',
                  ...(args.action === 'freeze' ? { sequence: ++sequence, values: spec.values } : {}) })
                expect(response.status).toBe(200); return
              }
              await new Promise(resolve => setTimeout(resolve, 10))
            }
            throw new Error('Control session did not reach the viewer')
          })()
          const [result] = await Promise.all([pending, acknowledgment]); return result
        } })
      } },
    }
    applyViewer(facade, defineTool, join(root, 'diagnostics'), 8000)
    await ctx.plugin(workflow)
    ctx.systemPrompt.section({ name: 'fixture', order: 1, text: 'You are Rumi, a model-editing tool. Work only on the current project. Preserve the current model while opening user controls. Available skills: interactive-controls and analog-shaping; read them with read using skills/<name>/SKILL.md. The current model is already loaded. Camera and rendering are supplied by the test viewer. Use the tools and then give a short status.' })
    ctx.tools.register(defineTool({ name: 'read', description: 'Read a project model or a skill.', parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        calls.push({ name: 'read', args })
        const skill = /(?:skills\/)?(interactive-controls|analog-shaping)(?:\/SKILL.md)?$/.exec(args.path)
        if (skill) return readFile(new URL(`../skills/${skill[1]}/SKILL.md`, import.meta.url), 'utf8')
        const path = resolve(root, args.path), part = relative(root, path)
        if (part.startsWith('..') || part.startsWith('/')) throw new Error('Use this fixture project')
        return readFile(path, 'utf8')
      },
    }))
    ctx.tools.register(defineTool({ name: 'shell', description: 'Run a shell command in the disposable project. Blender is at ' + blender, parameters: { command: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute(args) { calls.push({ name: 'shell', args }); const result = await runFile('/bin/sh', ['-c', args.command], { cwd: root, timeout: 90000, maxBuffer: 1024 * 1024 }); return result.stdout + result.stderr } }))
    const directory = join(root, 'models', 'example'); await mkdir(directory, { recursive: true })
    let path: string
    if (scenario.operation === 'parameters') {
      path = join(directory, 'model.js')
      const body = scenario.name.startsWith('Blender ') ? "const box=new THREE.Mesh(new THREE.BoxGeometry(p.width,50,40),material);box.name='Box';root.add(box);" : scenario.name === 'table width'
        ? 'const top=new THREE.Mesh(new THREE.BoxGeometry(p.width,50,4),material);top.name=\'Tabletop\';top.position.z=40;root.add(top);for(const x of [-1,1])for(const y of [-1,1]){const leg=new THREE.Mesh(new THREE.BoxGeometry(4,4,38),material);leg.position.set(x*(p.width/2-4),y*21,19);root.add(leg);}'
        : 'const base=new THREE.Mesh(new THREE.BoxGeometry(80,4,60),material);base.name=\'Base\';root.add(base);const feature=new THREE.Mesh(new THREE.BoxGeometry(8,8,8),material);feature.name=\'Feature\';feature.position.set(p.featureX,-6,p.featureZ);root.add(feature);'
      await writeFile(path, `export const parameters=${JSON.stringify(scenario.values)};\nexport function build(THREE,p){const root=new THREE.Group(),material=new THREE.MeshStandardMaterial();${body}return root;}\n`)
      if (scenario.name.startsWith('Blender ')) {
        ctx.systemPrompt.section({ name: 'fixture-source', order: 2, text: 'The current JavaScript model is a temporary interactive preview of models/example/original.blend. Its width parameter is the box X dimension in millimetres; the original has a single Box object.' })
        if (scenario.name === 'Blender width preview') await writeFile(join(directory, '.rumi-preview.json'), JSON.stringify({ original: 'models/example/original.blend', edit: 'Set the Box X dimension to width millimetres; preserve Y and Z dimensions.' }))
        await runFile(blender, ['--background', '--python-expr', `import bpy; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(); bpy.ops.mesh.primitive_cube_add(); o=bpy.context.object; o.name='Box'; o.dimensions=(0.08,0.05,0.04); bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(join(directory, 'original.blend'))})`], { timeout: 90000 })
      }
      if (scenario.name === 'both eyes' || scenario.name === 'fixed eye dimensions') {
        await writeFile(path, await readFile(new URL('./fixtures/parameter-faceplate.js', import.meta.url)))
      }
    } else {
      path = join(directory, 'model.glb')
      const text = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] })
      const content = Buffer.from(text + ' '.repeat((4 - text.length % 4) % 4)), bytes = Buffer.alloc(20 + content.length)
      ;[0x46546c67, 2, bytes.length, content.length, 0x4e4f534a].forEach((n, i) => bytes.writeUInt32LE(n, i * 4)); content.copy(bytes, 20)
      await writeFile(path, bytes)
      ctx.systemPrompt.section({ name: 'fixture-geometry', order: 2, text: 'The loaded fixture is a 100 mm cube centred at [0,0,50], bottom at z=0, with one Shell mesh. Cut direction [0,0,1] retains the upper side.' })
    }
    const originalHash = scenario.name.startsWith('Blender ') ? createHash('sha256').update(await readFile(join(directory, 'original.blend'))).digest('hex') : ''
    const agent = await ctx.agentLoop.create(sessionId, { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096, reasoningEffort: ReasoningEffortId('high') })
    await raw.get('viewer_load').execute({ path }, { agent, signal })
    async function send(text: string) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    }
    await send(scenario.prompt)
    const opened = calls.filter(call => call.name === 'viewer_controls' && call.args.action === 'open')
    expect(opened).toHaveLength(1)
    expect(opened[0]!.args.operation).toBe(scenario.operation)
    expect(opened[0]!.args.controls.some((control: any) => control.kind === scenario.kind)).toBe(true)
    expect(calls.some(call => call.name === 'read' && call.args.path.includes('interactive-controls'))).toBe(true)
    if (scenario.operation === 'parameters') expect(scenario.values).toMatchObject(opened[0]!.args.values)
    if (scenario.name === 'fixed eye dimensions') {
      expect(opened[0]!.args.controls.flatMap((control: any) => control.axes.map((axis: any) => axis.key))).toEqual(['eyeTilt'])
    }
    if (scenario.operation === 'bulge') expect(opened[0]!.args.controls.some((control: any) => control.kind === 'pad')).toBe(true)
    expect(calls.some(call => call.name === 'viewer_controls' && ['freeze', 'save', 'close'].includes(call.args.action))).toBe(false)
    if (scenario.finish) {
      const design = (await state()).design, values = { ...design.analog.values }
      const key = scenario.name === 'both eyes' ? 'eyeTilt' : 'width'
      values[key] = scenario.name === 'both eyes' ? -5 : 90
      expect((await feedback({ id: design.analog.id, url: design.url, status: 'adjusted', sequence: ++sequence, values })).status).toBe(200)
      await send(scenario.finish)
      expect((await state()).design.analog).toBeNull()
      if (scenario.name.startsWith('Blender ')) {
        expect(markerAtOpen).toBe(true)
        expect(JSON.parse(await readFile(join(directory, '.rumi-preview.json'), 'utf8'))).toMatchObject({ original: expect.any(String), edit: expect.any(String) })
        expect(frozenRecipe).toMatchObject({ finish: 'blender', values: { width: 90 } })
        expect(calls.some(call => call.name === 'viewer_controls' && call.args.action === 'freeze')).toBe(true)
        expect(calls.some(call => call.name === 'shell' && call.args.command.includes('blender'))).toBe(true)
        const published = calls.find(call => call.name === 'viewer_load' && String(call.args.path).endsWith('.glb'))
        expect(published).toBeDefined()
        expect(calls.some(call => call.name === 'viewer_controls' && call.args.action === 'save')).toBe(false)
        expect(createHash('sha256').update(await readFile(join(directory, 'original.blend'))).digest('hex')).toBe(originalHash)
        const glb = resolve(root, published!.args.path)
        const measured = await runFile(blender, ['--background', '--python-expr', `import bpy,json; bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(); bpy.ops.import_scene.gltf(filepath=${JSON.stringify(glb)}); o=next(o for o in bpy.context.scene.objects if o.type=='MESH'); print('DIMENSIONS='+json.dumps(list(o.dimensions)))`], { timeout: 90000 })
        const dimensions = JSON.parse(measured.stdout.match(/DIMENSIONS=(\[[^\n]+\])/u)![1]!)
        expect(dimensions[0]).toBeCloseTo(.09, 3); expect(dimensions[1]).toBeCloseTo(.05, 3); expect(dimensions[2]).toBeCloseTo(.04, 3)
      } else if (scenario.name === 'both eyes') {
        expect(JSON.parse(await readFile(join(directory, '.rumi-parameters.json'), 'utf8'))).toEqual(values)
        expect(calls.some(call => call.name === 'viewer_controls' && call.args.action === 'save')).toBe(true)
      } else await expect(readFile(join(directory, '.rumi-parameters.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    console.log('Agent controls result', JSON.stringify({ scenario: scenario.name, operation: opened[0]!.args.operation, controls: opened[0]!.args.controls, actions: calls.filter(call => call.name === 'viewer_controls').map(call => call.args.action) }))
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}, 180000)
