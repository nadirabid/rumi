/** Pending controls cannot bypass source-bound evidence and assessment. */
import { expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createControlReview } from '../viewer/analog/review.js'
import { measureControlCase } from '../viewer/analog/evidence.js'

const offsets = Array(81).fill(0); offsets[40] = 10
const input = { operation: 'fields', label: 'Profile', parts: ['Shell'], values: { depth: 0 },
  fields: [{ key: 'depth', origin: [-10, -10, -10], spacing: [10, 10, 10], dimensions: [3, 3, 3], offsets }],
  controls: [{ kind: 'slider', label: 'Depth', axes: [{ key: 'depth', min: 0, max: 1, step: .1, reset: 0 }] }],
  expectations: [{ key: 'depth', effect: 'Move the surface back', preserve: 'Keep the rim fixed' }],
}
const identity = { path: '/project/model.usda', revision: 1, url: '/source/one', contentHash: 'one' }
const png = 'data:image/png;base64,iVBORw0KGgo='
const assessments = [{ key: 'depth', decision: 'accept', observation: 'The surface moves back smoothly and the rim remains fixed.' }]
const combined = { decision: 'accept', observation: 'Combined extremes preserve the rim.' }

it('requires complete current evidence and explicit review before presentation', async () => {
  const review = createControlReview()
  try {
    const draft = review.prepare(input, identity)
    expect(draft.status).toBe('validation_required')
    expect(() => review.present(draft.id, identity)).toThrow('Validate')
    expect(() => review.review(draft.id, 'invented', assessments, combined)).toThrow('Generate')
    const work = review.validate(draft.id, new AbortController().signal, 1000)
    const request = review.request()!
    expect(() => review.deliver(request.id, { status: 'complete', cases: [] })).toThrow('Incomplete')
    const result = { status: 'complete', neutralMaxDisplacementMm: 0, cases: request.cases.map((test: { id: string }) => ({ id: test.id, maxDisplacementMm: 3, rmsDisplacementMm: 1, affectedFraction: .2, image: png })) }
    expect(review.deliver('stale', result)).toBe(false)
    expect(review.deliver(request.id, result)).toBe(true)
    const evidence = review.evidence(draft.id, (await work).cases)
    expect(() => review.present(draft.id, identity)).toThrow('Validate')
    expect(() => review.review(draft.id, evidence.evidenceId, [], combined)).toThrow('every')
    review.review(draft.id, evidence.evidenceId, assessments, combined)
    expect(review.present(draft.id, identity).fields).toEqual(input.fields)
    expect(() => review.present(draft.id, { ...identity, revision: 2 })).toThrow('Model changed')
    const replaced = review.prepare({ ...input, fields: [{ ...input.fields[0], spacing: [20, 20, 20] }] }, identity)
    expect(replaced.id).not.toBe(draft.id)
    expect(() => review.present(draft.id, identity)).toThrow('changed')
    expect(() => review.present(replaced.id, identity)).toThrow('Validate')
    expect(review.state()).toMatchObject({ status: 'validation_required', report: null, assessments: null })
  } finally { review.dispose() }
})

it('clears pending validation on cancellation, source invalidation, and disposal', async () => {
  const review = createControlReview(), abort = new AbortController()
  const draft = review.prepare(input, identity)
  const work = review.validate(draft.id, abort.signal, 1000)
  abort.abort(); expect(await work).toEqual({ status: 'cancelled' })
  expect(review.state()!.status).toBe('validation_required')
  const retry = review.validate(draft.id, new AbortController().signal, 1000)
  review.reset(); expect(await retry).toEqual({ status: 'cancelled' }); expect(review.state()).toBeNull()
  const other = review.prepare(input, identity), pending = review.validate(other.id, new AbortController().signal, 1000)
  review.dispose(); expect(await pending).toEqual({ status: 'cancelled' })
})

it('measures actual surface samples rather than an interior lattice peak', () => {
  const root = new THREE.Group(), geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 9, 0, 1, 9, 0, 0, 9, 1], 3))
  const material = new THREE.MeshBasicMaterial(), mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Shell'; root.add(mesh)
  try {
    const report = measureControlCase(root, input, { baseline: { depth: 0 }, values: { depth: 1 } })
    expect(report.metrics.maxDisplacementMm).toBeCloseTo(1)
    expect(report.metrics.maxDisplacementMm).toBeLessThan(10)
    expect(mesh.geometry).toBe(geometry)
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 9, 0, 1, 9, 0, 0, 9, 1])
    expect(measureControlCase(root, input, { baseline: null, values: { depth: 0 } }).metrics.maxDisplacementMm).toBe(0)
  } finally { geometry.dispose(); material.dispose() }
})


it('keeps failed, timed-out, and rejected reviews unavailable for presentation', async () => {
  vi.useFakeTimers()
  const review = createControlReview()
  try {
    const draft = review.prepare(input, identity)
    const first = review.validate(draft.id, new AbortController().signal, 1000)
    review.deliver(review.request()!.id, { status: 'failed', message: 'Renderer unavailable' })
    expect(await first).toMatchObject({ status: 'validation_failed' })
    expect(() => review.present(draft.id, identity)).toThrow('Validate')
    const second = review.validate(draft.id, new AbortController().signal, 1000)
    const expired = review.request()!.id
    await vi.advanceTimersByTimeAsync(1000)
    expect(await second).toMatchObject({ status: 'validation_failed', message: expect.stringContaining(`Prepared controls ${draft.id} are retained`) })
    expect(review.state()).toMatchObject({ id: draft.id, status: 'validation_required' })
    expect(review.request()).toBeNull()
    const third = review.validate(draft.id, new AbortController().signal, 1000)
    const request = review.request()!
    expect(request.id).not.toBe(expired)
    expect(review.deliver(expired, { status: 'failed', message: 'Late renderer result' })).toBe(false)
    review.deliver(request.id, { status: 'complete', neutralMaxDisplacementMm: 0, cases: request.cases.map((test: { id: string }) => ({ id: test.id, maxDisplacementMm: 0, rmsDisplacementMm: 0, affectedFraction: 0, image: png })) })
    const evidence = review.evidence(draft.id, (await third).cases)
    review.review(draft.id, evidence.evidenceId, [{ ...assessments[0], decision: 'revise', observation: 'The intended surface does not move.' }], combined)
    expect(review.state()!.status).toBe('needs_revision')
    expect(() => review.present(draft.id, identity)).toThrow('Validate')
  } finally { review.dispose(); vi.useRealTimers() }
})

it('blocks surface presentation when new triangle pairs intersect, regardless of agent assessment', () => {
  const review = createControlReview()
  const draft = review.prepare({ operation: 'surface', label: 'Profile', parts: ['Shell'],
    form: { kind: 'profile', at: [0, .5, 1], pinned: [0, 2] }, values: { p1: 0 },
    controls: [{ kind: 'slider', label: 'Height', axes: [{ key: 'p1', min: -12, max: 12, step: 1, reset: 0 }] }],
    expectations: [{ key: 'p1', effect: 'Raise crown', preserve: 'Keep wall intact' }],
  }, identity)
  try {
    expect(() => review.validate(draft.id, new AbortController().signal, 100)).toThrow('host geometry')
    const findings = review.geometryRequest(draft.id)!.cases.map((item: { id: string }) => ({ id: item.id,
      baselineIntersectionPairs: 52, intersectionPairs: 52, newIntersectionPairs: 1 }))
    const rejected = review.geometry(draft.id, findings)
    expect(rejected.status).toBe('needs_revision')
    expect({ ...rejected, id: '<prepared-controls>' }).toMatchSnapshot()
    expect(() => review.validate(draft.id, new AbortController().signal, 100)).toThrow('host geometry')
    expect(() => review.review(draft.id, 'invented', [{ key: 'p1', decision: 'accept', observation: 'Near an existing defect' }], combined)).toThrow('Generate')
    expect(() => review.present(draft.id, identity)).toThrow('Validate')
  } finally { review.dispose() }
})


it('explains omitted field values and accepts the same controls when zero values are supplied', () => {
  const review = createControlReview()
  try {
    expect(() => review.prepare({ ...input, values: undefined }, identity)).toThrowErrorMatchingSnapshot()
    expect(review.state()).toBeNull()
    expect(review.prepare(input, identity).status).toBe('validation_required')
  } finally { review.dispose() }
})
