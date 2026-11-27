/** Assembly declarations bind every exported mesh and preserve requested movement. */
import { expect, it } from 'vitest'
import { mechanismMetadata, withMechanismMetadata } from '../viewer/mechanics.js'
import { validateGlb } from '../viewer/glb.js'

const hinge = { id: 'hinge', parent: 'frame', child: 'door', kind: 'revolute', axis: [2, 0, 0], pivot: [0, 0, 10], range: [0, 90], control: 'openDoor' }
const assembly = () => ({ version: 1, root: 'frame', parts: [{ id: 'frame', mesh: 'Frame' }, { id: 'door', mesh: 'Door' }],
  connections: [hinge], manufacturing: { mode: 'print-in-place' } })
const manifest = (extras: object, nodes = [{ name: 'Frame', mesh: 0 }, { name: 'Door', mesh: 1 }]) => ({ asset: { version: '2.0', extras }, nodes })
const motion = { rumiMotionKeys: ['openDoor'], rumiMotionRanges: [{ key: 'openDoor', range: [0, 90] }] }

it('derives a one-part static assembly so disconnected material still reaches native validation', () => {
  for (const extras of [{}, { rumiMotionKeys: [], rumiMotionRanges: [] }]) {
    expect(mechanismMetadata(manifest(extras, [{ name: 'Block', mesh: 0 }]))).toEqual({ declared: true,
      assembly: { version: 1, root: 'Block', parts: [{ id: 'Block', mesh: 'Block' }], connections: [], sequences: [], manufacturing: { mode: 'print-in-place' } },
      mechanisms: [], motionKeys: [], motionRanges: [], checks: [] })
  }
})

it('does not infer static intent from missing identity or invalid motion metadata', () => {
  for (const nodes of [[{ name: '', mesh: 0 }], [{ name: 'Block', mesh: 0 }, { name: 'Block' }], []]) {
    expect(mechanismMetadata(manifest({}, nodes)).assembly).toBeNull()
  }
  expect(mechanismMetadata(manifest({ rumiMotionKeys: null }, [{ name: 'Block', mesh: 0 }])).assembly).toBeNull()
  expect(mechanismMetadata(manifest(motion, [{ name: 'Block', mesh: 0 }])).assembly).toBeNull()
})

it('requires a description for multiple parts and legacy movement declarations', () => {
  for (const extras of [{}, motion, { rumiMechanisms: [{ ...hinge, movingBody: 'Door' }] }]) {
    expect(mechanismMetadata(manifest(extras)).checks).toMatchObject([{ code: 'assembly_description_required', severity: 'error' }])
  }
})

it('normalizes assembly axes and preserves complete control coverage', () => {
  const result = mechanismMetadata(manifest({ ...motion, rumiAssembly: assembly() }))
  expect(result.checks).toEqual([])
  expect(result.assembly!.connections[0]).toMatchObject({ parent: 'frame', child: 'door', axis: [1, 0, 0] })
  expect(result.motionRanges).toEqual(motion.rumiMotionRanges)
})

it.each([
  { ...hinge, range: [10, 90] }, { ...hinge, axis: [0, 0, 0] }, { ...hinge, pivot: [0, NaN, 0] },
  { ...hinge, kind: 'animation' }, { ...hinge, child: 'ghost' }, { ...hinge, range: [-360, 360] },
])('rejects unsupported or incomplete joint intent before physical evaluation', (connection) => {
  const result = mechanismMetadata(manifest({ rumiAssembly: { ...assembly(), connections: [connection] } }))
  expect(result.assembly).toBeNull()
  expect(result.checks[0]!.code).toBe('assembly_description_invalid')
})

it('rejects unmapped, duplicate and ambiguous exported mesh names', () => {
  const original = assembly()
  for (const input of [
    { ...original, parts: original.parts.slice(0, 1) },
    { ...original, parts: [original.parts[0], { id: 'door', mesh: 'Frame' }] },
    { ...original, parts: [original.parts[0], { id: 'frame', mesh: 'Door' }] },
  ]) expect(mechanismMetadata(manifest({ rumiAssembly: input })).assembly).toBeNull()
  for (const nodes of [[{ name: 'Frame', mesh: 0 }, { name: 'Door' }],
    [{ name: 'Frame', mesh: 0 }, { name: 'Door', mesh: 1 }, { name: 'Door' }]]) {
    expect(mechanismMetadata(manifest({ rumiAssembly: original }, nodes)).assembly).toBeNull()
  }
})

it('requires fixed hardware to be connected to the root', () => {
  const original = assembly()
  const cap = { id: 'cap', mesh: 'Cap' }
  const nodes = [...manifest({}).nodes, { name: 'Cap', mesh: 2 }]
  const disconnected = { ...original, parts: [...original.parts, cap] }
  expect(mechanismMetadata(manifest({ rumiAssembly: disconnected }, nodes)).checks).toMatchObject([{ code: 'assembly_part_disconnected' }])
  const connected = { ...disconnected, connections: [...original.connections, { id: 'retain', parent: 'frame', child: 'cap', kind: 'fixed' }] }
  expect(mechanismMetadata(manifest({ rumiAssembly: connected }, nodes)).checks).toEqual([])
})

it('preserves closed-loop descriptions for the native supported-domain decision', () => {
  const original = assembly()
  const graph = { ...original, connections: [...original.connections, { id: 'loop', parent: 'door', child: 'frame', kind: 'fixed' }] }
  expect(mechanismMetadata(manifest({ rumiAssembly: graph })).assembly!.connections).toHaveLength(2)
})

it('does not validate a smaller range than the movement control exposes', () => {
  const description = { ...assembly(), connections: [{ ...hinge, range: [0, 30] }] }
  expect(mechanismMetadata(manifest({ ...motion, rumiAssembly: description })).checks).toMatchObject([{ code: 'mechanism_control_range_uncovered' }])
  expect(mechanismMetadata(manifest({ ...motion, rumiMotionRanges: [], rumiAssembly: assembly() })).checks[0]!.code).toBe('assembly_description_invalid')
  expect(mechanismMetadata(manifest({ ...motion, rumiMotionKeys: ['other'], rumiAssembly: assembly() })).checks[0]!.code).toBe('mechanism_declaration_missing')
})

it.each([
  { rumiMotionRanges: [{ key: 'openDoor', range: [0, Infinity] }] },
  { rumiMotionRanges: [{ key: 'openDoor', range: [1, 90] }] },
  { rumiMotionRanges: [{ key: 'openDoor', range: [0, 90] }, { key: 'openDoor', range: [0, 30] }] },
  { rumiMotionKeys: ['openDoor', 'openDoor'] },
])('rejects ambiguous control metadata', (controlMetadata) => {
  expect(mechanismMetadata(manifest({ ...controlMetadata, rumiAssembly: assembly() })).assembly).toBeNull()
})

it('preserves in-range movement sequences and rejects invented or fixed targets', () => {
  const description = { ...assembly(), sequences: [{ id: 'open', waypoints: [{ hinge: 45 }, { hinge: 90 }] }] }
  expect(mechanismMetadata(manifest({ rumiAssembly: description })).assembly!.sequences).toEqual(description.sequences)
  for (const waypoints of [[{ hinge: 91 }], [{ ghost: 0 }], [{}]]) {
    expect(mechanismMetadata(manifest({ rumiAssembly: { ...description, sequences: [{ id: 'bad', waypoints }] } })).assembly).toBeNull()
  }
})

it('requires manufacturing mode without treating an assembly route as proven', () => {
  expect(mechanismMetadata(manifest({ rumiAssembly: { ...assembly(), manufacturing: null } })).assembly).toBeNull()
  const result = mechanismMetadata(manifest({ rumiAssembly: { ...assembly(), manufacturing: { mode: 'separate' } } }))
  expect(result.assembly!.manufacturing).toEqual({ mode: 'separate' })
})

it('preserves geometry bytes while embedding the assembly in the saved GLB', () => {
  const json = new TextEncoder().encode(JSON.stringify(manifest({})))
  const size = Math.ceil(json.length / 4) * 4
  const bytes = new Uint8Array(20 + size + 12), header = new DataView(bytes.buffer)
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true)
  header.setUint32(12, size, true); header.setUint32(16, 0x4e4f534a, true)
  bytes.fill(32, 20, 20 + size); bytes.set(json, 20)
  header.setUint32(20 + size, 4, true); header.setUint32(24 + size, 0x004e4942, true)
  bytes.set([1, 2, 3, 4], 28 + size)
  const result = new Uint8Array(withMechanismMetadata(bytes.buffer, { rumiAssembly: assembly() }))
  expect([...result.slice(-12)]).toEqual([...bytes.slice(-12)])
  expect(mechanismMetadata(validateGlb(result)).assembly!.parts).toEqual(assembly().parts)
})

it('preserves bounded removal paths and rejects missing parts or unsupported route transforms', () => {
  const manufacturing = { mode: 'separate', steps: [{ part: 'door', path: [[0, 0, 0], [0, 0, 100]] }] }
  expect(mechanismMetadata(manifest({ rumiAssembly: { ...assembly(), manufacturing } })).assembly!.manufacturing).toEqual(manufacturing)
  for (const steps of [[], [{ part: 'ghost', path: [[0, 0, 0], [0, 0, 100]] }],
    [{ part: 'door', path: [[0, 1, 0], [0, 0, 100]] }], [{ part: 'door', path: [[0, 0, 0], [0, 0, 100]], rotation: [0, 90, 0] }]]) {
    expect(mechanismMetadata(manifest({ rumiAssembly: { ...assembly(), manufacturing: { mode: 'separate', steps } } })).assembly).toBeNull()
  }
})

it('rejects connections directed toward the root without an outward connection path', () => {
  const description = { ...assembly(), connections: [{ ...hinge, parent: 'door', child: 'frame' }] }
  const result = mechanismMetadata(manifest({ rumiAssembly: description }))
  expect(result.assembly).toBeNull()
  expect(result.checks).toMatchObject([{ code: 'assembly_part_disconnected', severity: 'error' }])
})

it('preserves saved-value origins and rejects invalid canonical intervals', () => {
  const description = { ...assembly(), connections: [{ ...hinge, range: [-30, 60] }] }
  const motionRanges = [{ key: 'openDoor', range: [-30, 60], origin: 30 }]
  const result = mechanismMetadata(manifest({ rumiAssembly: description, rumiMotionRanges: motionRanges }))
  expect(result.checks).toEqual([])
  expect(result.motionRanges).toEqual(motionRanges)
  for (const origin of [null, Infinity, '30', 1e308]) {
    expect(mechanismMetadata(manifest({ rumiAssembly: description,
      rumiMotionRanges: [{ key: 'openDoor', range: [-30, 60], origin }] })).assembly).toBeNull()
  }
})
