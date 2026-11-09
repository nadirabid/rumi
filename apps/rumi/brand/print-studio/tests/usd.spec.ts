/** USD Physics declarations drive the same visible model and mechanical intent. */
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { robotUsd } from './fixtures/robot-usd.js'
import { validateUsd } from '../viewer/usd.js'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { analyzeMesh } from '../viewer/checks.js'

it('loads Blender USD geometry and derives its joint control from the Isaac relationships', async () => {
  const model = await parseUsdModel(robotUsd().buffer)
  try {
    expect(model.motionIssue).toBeUndefined()
    expect(analyzeMesh(model.positions).dimensions).toMatchObject({
      x: expect.closeTo(45, 3), y: expect.closeTo(20, 3), z: expect.closeTo(20, 3),
    })
    expect(model.robot.assembly.connections).toEqual([{ id: 'DoorHinge', parent: 'Body', child: 'Door', kind: 'revolute',
      axis: [0, 0, 1], pivot: [15, 0, 0], range: [0, 90], control: 'Door' }])
    expect(model.motionDefinitions[0].axes[0]).toMatchObject({ min: 0, max: 90 })
    const saved = model.positions.slice()
    const parent = new THREE.Group()
    const preview = model.createMotionPreview(parent)
    preview.update({ joint0: 90 })
    const door = parent.getObjectByName('Door')!
    const center = new THREE.Box3().setFromObject(door).getCenter(new THREE.Vector3())
    expect(center.x).toBeCloseTo(15, 3)
    expect(center.y).toBeCloseTo(10, 3)
    expect(model.positions).toEqual(saved)
    preview.dispose()
    expect(model.root.visible).toBe(true)
  } finally { disposeModel(model.root) }
})

it('keeps geometry visible but withholds controls when a joint references a missing link', async () => {
  const text = validateUsd(robotUsd()).replace('rel physics:body1 = </Model/Door>', 'rel physics:body1 = </Model/Missing>')
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.positions.length).toBeGreaterThan(0)
    expect(model.motionDefinitions).toBeUndefined()
    expect(model.motionIssue).toContain('body0 and body1')
  } finally { disposeModel(model.root) }
})

it.each(['@../../private.usda@', 'subLayers', 'references', 'payload', 'timeSamples', 'variantSet'])('rejects %s before resolving project assets', (value) => {
  expect(() => validateUsd(new TextEncoder().encode(`#usda 1.0\n${value}\n`))).toThrow('Flatten USD')
})

it.each([
  ['point3f physics:localPos1 = (-0.01, 0, 0)', 'point3f physics:localPos1 = (0, 0, 0)', 'frames must meet'],
  ['float physics:upperLimit = 90', '', 'finite'],
  ['uniform token physics:axis = "Z"', 'uniform token physics:axis = "Z"\n        quatf physics:localRot1 = (0, 1, 0, 0)', 'axes must agree'],
])('withholds motion for an inconsistent joint declaration: %s', async (before, after, message) => {
  const text = validateUsd(robotUsd()).replace(before, after)
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.positions.length).toBeGreaterThan(0)
    expect(model.motionDefinitions).toBeUndefined()
    expect(model.motionIssue).toContain(message)
  } finally { disposeModel(model.root) }
})

it('converts prismatic metre limits to millimetre controls', async () => {
  const text = validateUsd(robotUsd()).replace('PhysicsRevoluteJoint', 'PhysicsPrismaticJoint').replace('float physics:upperLimit = 90', 'float physics:upperLimit = 0.02')
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.motionIssue).toBeUndefined()
    expect(model.robot.assembly.connections[0].range).toEqual([0, 20])
    expect(model.motionDefinitions[0].axes[0].max).toBe(20)
  } finally { disposeModel(model.root) }
})

it.each(['physics:rigidBodyEnabled', 'physics:collisionEnabled'])('withholds controls for a disabled %s', async (attribute) => {
  const text = validateUsd(robotUsd()).replace('float3[] extent', `bool ${attribute} = false\n        float3[] extent`)
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.motionDefinitions).toBeUndefined()
    expect(model.motionIssue).toContain('enabled dynamic rigid bodies')
  } finally { disposeModel(model.root) }
})

it('rejects fixed joint frames with inconsistent rest rotations', async () => {
  const text = validateUsd(robotUsd()).replace('PhysicsRevoluteJoint', 'PhysicsFixedJoint')
    .replace('uniform token physics:axis = "Z"', 'quatf physics:localRot1 = (0, 1, 0, 0)')
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.motionIssue).toContain('Fixed joint body frame rotations must agree')
  } finally { disposeModel(model.root) }
})
