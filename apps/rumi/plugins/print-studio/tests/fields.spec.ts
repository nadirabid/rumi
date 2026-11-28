/** Field previews preserve saved geometry and interpolate smoothly inside support bounds. */
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { parameterValues, normalizeControls } from '../viewer/analog/control-spec.js'
import { normalizeShape } from '../viewer/analog/spec.js'
import { sampleField } from '../viewer/analog/fields.js'
import { createFieldPreview } from '../viewer/analog/field-preview.js'

const field = { key: 'crown', origin: [-10,-10,-10], spacing: [10,10,10], dimensions: [3,3,3], offsets: Array(81).fill(0) }
field.offsets[41] = 10
const input = { operation: 'fields', label: 'Crown', parts: ['Shell'], fields: [field], values: { crown: 0 }, controls: [{ kind: 'slider', label: 'Height', axes: [{ key: 'crown', min: -1, max: 1, step: .01, reset: 0 }] }] }

it('interpolates trilinearly at interior points and stays zero on boundaries and exterior', () => {
  const expected: Array<[number[], number]> = [[[0, 0, 0], 10], [[5, 5, 5], 1.25], [[-10, 0, 0], 0], [[11, 0, 0], 0], [[0, -4, 7], 1.8]]
  for (const [point, z] of expected) {
    const [dx, dy, dz] = sampleField(point, field)
    expect(dx).toBe(0)
    expect(dy).toBe(0)
    expect(dz).toBeCloseTo(z, 9)
  }
})

it('rejects discontinuities, unbound fields and unsafe ranges', () => {
  expect(() => normalizeShape({ ...input, fields: [{ ...field, offsets: field.offsets.map((v,i)=>i===0?1:v) }] })).toThrow('boundary')
  expect(() => normalizeShape({ ...input, fields: [{ ...field, key: 'missing' }] })).toThrow('binding')
  expect(() => normalizeShape({ ...input, controls: [{ ...input.controls[0], axes: [{ ...input.controls[0].axes[0], max: 2 }] }] })).toThrow('ranges')
})

it('moves selected geometry from its baseline and restores the original on disposal', () => {
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(2,2,2))
  mesh.name = 'Shell'; root.add(mesh)
  const original = mesh.geometry, baseline = Array.from(original.attributes.position.array)
  const preview = createFieldPreview(root, normalizeShape(input))
  preview.update({ crown: 1 })
  expect(Array.from(mesh.geometry.attributes.position.array)).not.toEqual(baseline)
  expect(Array.from(original.attributes.position.array)).toEqual(baseline)
  preview.update({ crown: 0 })
  expect(Array.from(mesh.geometry.attributes.position.array)).toEqual(baseline)
  preview.dispose(); expect(mesh.geometry).toBe(original)
  expect(() => createFieldPreview(root, { ...normalizeShape(input), parts: ['Missing'] })).toThrow('match')
  original.dispose()
})

it('freezes the latest released field values and invalidates controls when the source changes', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createSource } = await import('../viewer/source.js')
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'rumi-fields-'))
  try {
    const scoped = ctx as Context & { connection: { fetch: { register: () => () => void } } }
    scoped.connection = { fetch: { register: () => () => {} } }
    const path = join(root, 'model.usda')
    await writeFile(path, '#usda 1.0\n')
    const source = await createSource(scoped, path, root), state = source.state()
    const open = source.shape({ ...state, ...input })
    source.shapeFeedback({ id: open.id, url: state.url, status: 'rendered' })
    source.requestShapeFreeze(open.id)
    source.shapeFeedback({ id: open.id, url: state.url, status: 'frozen', sequence: 1, values: { crown: -.75 } })
    const frozen = source.freezeShape(open.id)
    expect({ operation: frozen.operation, values: frozen.values, fields: frozen.fields }).toMatchSnapshot()
    await writeFile(path, '#usda 1.0\n# changed\n')
    await source.poll()
    expect(() => source.shape({ ...state, ...input })).toThrow('changed')
    await source.poll()
    expect(source.state().analog).toBeNull()
    expect(() => source.shape({ ...state, ...input })).toThrow('changed')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})


it.each([null, [], '{"width":0}', 0])('distinguishes malformed values %j from too many parameters', (values) => {
  expect(() => parameterValues(values)).toThrow('Invalid values: expected an object')
})

it('reports actual parameter counts, invalid numbers, and missing axis values separately', () => {
  expect(() => parameterValues(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, 0])))).toThrow('received 33; at most 32')
  expect(() => parameterValues({ width: '0' })).toThrow('values.width must be a finite number')
  expect(() => parameterValues({ width: 1000001 })).toThrow('values.width must be between')
  expect(() => parameterValues({ 'bad key': 0 })).toThrow('Invalid parameter key')
  expect(() => normalizeControls(input.controls, {})).toThrow('Missing control value: values.crown')
  expect(() => normalizeControls([...input.controls, ...input.controls], { crown: 0 })).toThrow('Duplicate control binding: crown')
  expect(parameterValues({ width: 0, height: 0, standoff: 0, eyes: 0 })).toEqual({ width: 0, height: 0, standoff: 0, eyes: 0 })
})
