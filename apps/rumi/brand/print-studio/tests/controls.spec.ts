/** Generic bindings change real geometry and preserve released parameters across reload. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as THREE from 'three'
import { expect, it } from 'vitest'
import { normalizeShape } from '../viewer/analog/spec.js'
import { normalizeControls } from '../viewer/analog/control-spec.js'
import { generateModule } from '../viewer/generation/export.js'
import { createParameterPreview } from '../viewer/analog/parameters.js'
import { buildModel, disposeModel } from '../viewer/viewport/model.js'
import { build, parameters } from './fixtures/parameter-faceplate.js'
import { readMotion } from '../viewer/motion.js'
import { createSource } from '../viewer/source.js'

const controls = [{ kind: 'slider', label: 'Eye tilt', axes: [{ key: 'eyeTilt', min: -25, max: 25, step: .5, reset: 10 }] }]
const spec = normalizeShape({ operation: 'parameters', label: 'Eyes', controls, values: { eyeTilt: 10 } })

it('exposes a subset of the model parameters without removing fixed values', async () => {
  const partial = normalizeShape({ operation: 'parameters', label: 'Eyes', controls, values: parameters })
  expect(partial.values).toEqual(parameters)
  expect(partial.controls.flatMap(control => control.axes.map(axis => axis.key))).toEqual(['eyeTilt'])
  const model = { ...buildModel(build, parameters), generate: values => generateModule({ build, parameters }, values), parameters }
  const parent = new THREE.Group()
  parent.add(model.root)
  const preview = createParameterPreview(parent, model, partial)
  await preview.update({ ...parameters, eyeTilt: -5 })
  expect(parent.children).toHaveLength(2)
  expect(model.parameters.eyeHeight).toBe(9)
  preview.dispose(); disposeModel(model.root)
})

it('binds one labeled parameter to both eye cutouts, rejects unknown bindings, and restores the saved model', async () => {
  const model = { ...buildModel(build, parameters), generate: values => generateModule({ build, parameters }, values), parameters }
  const parent = new THREE.Group()
  parent.add(model.root)
  expect(() => createParameterPreview(parent, model, { ...spec, values: { unknown: 1 } })).toThrow('declared')
  const preview = createParameterPreview(parent, model, spec)
  const baseline = model.positions.slice()
  await preview.update({ eyeTilt: 10 })
  const geometry = () => {
    const points: number[] = []
    parent.children[1]!.updateMatrixWorld(true)
    parent.children[1]!.traverse((node: THREE.Object3D) => {
      if (!(node instanceof THREE.Mesh)) return
      const attribute = node.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i++) {
        points.push(...new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(node.matrixWorld).toArray())
      }
    })
    return points
  }
  const first = geometry()
  await preview.update({ eyeTilt: -15 })
  expect(geometry()).not.toEqual(first)
  const expected = buildModel(build, { ...parameters, eyeTilt: -15 })
  geometry().forEach((value, i) => expect(value).toBeCloseTo(expected.positions[i]!, 4))
  expect(model.positions).toEqual(baseline)
  expect(() => preview.update({ eyeTilt: 90 })).toThrow('range')
  geometry().forEach((value, i) => expect(value).toBeCloseTo(expected.positions[i]!, 4))
  preview.dispose()
  expect(parent.children).toEqual([model.root]); expect(model.root.visible).toBe(true)
  disposeModel(expected.root); disposeModel(model.root)
})

it('rejects duplicate bindings, absent values, and invalid reset ranges', () => {
  expect(() => normalizeControls([...controls, ...controls], { eyeTilt: 10 })).toThrow('duplicate')
  expect(() => normalizeControls(controls, {})).toThrow('binding')
  expect(() => normalizeControls([{ ...controls[0], axes: [{ ...controls[0]!.axes[0], reset: 50 }] }], { eyeTilt: 10 })).toThrow('range')
})

it('freezes the latest parameter values, saves atomically, reloads them, and cancels without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-controls-')), ctx = new Context()
  try {
    const path = join(root, 'model.js')
    await writeFile(path, 'export const parameters = { eyeTilt: 10 }; export function build() {}\n')
    const scoped = ctx as Context & { connection: { fetch: { register: () => () => void } } }
    scoped.connection = { fetch: { register: () => () => {} } }
    const source = await createSource(scoped, path, root), state = source.state()
    const open = source.shape({ ...state, ...spec })
    expect(source.shapeFeedback({ id: open.id, url: state.url, status: 'rendered' })).toBe(true)
    source.requestShapeFreeze(open.id)
    expect(source.shapeFeedback({ id: open.id, url: state.url, status: 'frozen', sequence: 1, values: { eyeTilt: -12 } })).toBe(true)
    expect(source.freezeShape(open.id).values).toEqual({ eyeTilt: -12 })
    await source.saveParameters(open.id)
    expect(source.state().analog).toBeNull()
    expect(JSON.parse(await readFile(join(root, '.rumi-parameters.json'), 'utf8'))).toEqual({ eyeTilt: -12 })
    const restored = await createSource(scoped, path, root)
    expect(restored.state().parameters).toEqual({ eyeTilt: -12 })
    const again = restored.shape({ ...restored.state(), ...spec, values: { eyeTilt: -12 } })
    restored.clearShape(again.id)
    await expect(restored.saveParameters(again.id)).rejects.toThrow('Freeze')
    expect(JSON.parse(await readFile(join(root, '.rumi-parameters.json'), 'utf8'))).toEqual({ eyeTilt: -12 })
    expect(restored.shapeFeedback({ id: again.id, url: state.url, status: 'adjusted', sequence: 2, values: { eyeTilt: 10 } })).toBe(false)
    await restored.dispose(); await source.dispose()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('keeps a Blender preview frozen with its latest values and refuses to save it as a final parameter model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rumi-preview-')), ctx = new Context()
  try {
    const path = join(root, 'model.js')
    await writeFile(path, 'export const parameters = { eyeTilt: 10 }; export function build() {}\n')
    const scoped = ctx as Context & { connection: { fetch: { register: () => () => void } } }
    scoped.connection = { fetch: { register: () => () => {} } }
    const source = await createSource(scoped, path, root), state = source.state()
    const open = source.shape({ ...state, ...spec, finish: 'blender', original: 'original.blend', originalHash: 'hash', edit: 'Tilt both openings by eyeTilt degrees; preserve the shell.' })
    source.shapeFeedback({ id: open.id, url: state.url, status: 'rendered' })
    source.requestShapeFreeze(open.id)
    source.shapeFeedback({ id: open.id, url: state.url, status: 'frozen', sequence: 1, values: { eyeTilt: -15 } })
    expect(source.freezeShape(open.id)).toMatchObject({ finish: 'blender', original: 'original.blend', originalHash: 'hash', values: { eyeTilt: -15 } })
    await expect(source.saveParameters(open.id)).rejects.toThrow('finished in Blender')
    expect(source.state().analog?.frozen).toBe(true)
    await expect(readFile(join(root, '.rumi-parameters.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('validates persistent movement declarations and retains only compatible pose values', () => {
  const model = { eyeTilt: 10, width: 20 }
  expect(readMotion(undefined, model)).toBeNull()
  expect(readMotion([], model)).toBeNull()
  expect(readMotion(controls, model, { eyeTilt: -5, removed: 7 })).toEqual({ controls, values: { eyeTilt: -5 } })
  expect(readMotion(controls, model, { eyeTilt: 100 }).values).toEqual({ eyeTilt: 10 })
  expect(() => readMotion(controls, { width: 20 })).toThrow('Missing')
  expect(() => readMotion('invalid', model)).toThrow('controls')
})

it('coalesces parameter generation, shares a pending freeze, and retains the last preview on failure', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const calls: number[] = []
  const model = { ...buildModel(build, parameters), parameters, generate: async (values) => {
    calls.push(values.eyeTilt)
    if (values.eyeTilt === 5) { started.resolve(); await release.promise }
    if (values.eyeTilt === 20) throw new Error('Generation failed')
    return generateModule({ build, parameters }, values)
  } }
  const parent = new THREE.Group(); parent.add(model.root)
  const preview = createParameterPreview(parent, model, spec)
  try {
    const first = preview.update({ eyeTilt: 5 })
    await started.promise
    const superseded = preview.update({ eyeTilt: 6 })
    const latest = preview.update({ eyeTilt: 7 })
    expect(preview.update({ eyeTilt: 7 })).toBe(latest)
    release.resolve()
    expect(await first).toBe(false); expect(await superseded).toBe(false); expect(await latest).toBe(true)
    expect(calls).toEqual([5, 7])
    const displayed = parent.children[1]
    await expect(preview.update({ eyeTilt: 20 })).rejects.toThrow('Generation failed')
    expect(parent.children[1]).toBe(displayed)
    expect(model.root.visible).toBe(false)
  } finally { release.resolve(); await preview.dispose(); disposeModel(model.root) }
})

it('waits for pending generation on disposal without attaching its result', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const model = { ...buildModel(build, parameters), parameters, generate: async (values) => {
    started.resolve(); await release.promise
    return generateModule({ build, parameters }, values)
  } }
  const parent = new THREE.Group(); parent.add(model.root)
  const preview = createParameterPreview(parent, model, spec)
  const update = preview.update({ eyeTilt: 5 }); await started.promise
  const disposed = preview.dispose(); release.resolve()
  expect(await update).toBe(false); await disposed
  expect(parent.children).toEqual([model.root]); expect(model.root.visible).toBe(true)
  disposeModel(model.root)
})
