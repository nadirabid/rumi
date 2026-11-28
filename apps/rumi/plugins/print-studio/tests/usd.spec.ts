/** USD Physics declarations drive the same visible model and mechanical intent. */
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { robotUsd } from './fixtures/robot-usd.js'
import { validateUsd, usdRequiresSeparatePrint } from '../viewer/usd.js'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { analyzeMesh } from '../viewer/checks.js'

function withMotionControls(text: string, controls: unknown) {
  return new TextEncoder().encode(text.replace('token rumi:manufacturingMode',
    `string rumi:motionControls = ${JSON.stringify(JSON.stringify(controls))}\n    token rumi:manufacturingMode`)).buffer
}

function twoJointUsd() {
  const text = validateUsd(robotUsd())
  const mesh = text.slice(text.indexOf('    def Mesh "Door"'), text.indexOf('    def Mesh "Body"')).replace('"Door"', '"Slide"')
  const joint = text.slice(text.indexOf('    def PhysicsRevoluteJoint'), text.lastIndexOf('}'))
    .replace('PhysicsRevoluteJoint "DoorHinge"', 'PhysicsPrismaticJoint "SlideJoint"')
    .replace('</Model/Door>', '</Model/Slide>').replace('"Door"', '"Slide"')
    .replace('upperLimit = 90', 'upperLimit = 0.02').replace('axis = "Z"', 'axis = "X"')
  return text.replace('robotJoints = </Model/DoorHinge>', 'robotJoints = [</Model/DoorHinge>, </Model/SlideJoint>]')
    .replace('</Model/Body>,', '</Model/Body>, </Model/Slide>,').replace(/}\s*$/, `${mesh}${joint}}`)
}

it('binds a pad to two USD joints and retains sliders for unspecified movements', async () => {
  for (const kind of ['pad', 'slider']) {
    const axes = [{ joint: '/Model/DoorHinge' }, ...(kind === 'pad' ? [{ joint: '/Model/SlideJoint', step: 0.25 }] : [])]
    const model = await parseUsdModel(withMotionControls(twoJointUsd(), [{ kind, label: 'Position', axes }]))
    try {
      expect(model.motionIssue).toBeUndefined()
      expect(model.motionDefinitions.map(control => control.kind)).toEqual(kind === 'pad' ? ['pad'] : ['slider', 'slider'])
      const allAxes = model.motionDefinitions.flatMap(control => control.axes)
      expect(allAxes.map(axis => [axis.min, axis.max, axis.reset])).toEqual([[0, 90, 0], [0, 20, 0]])
      const parent = new THREE.Group(), preview = model.createMotionPreview(parent)
      preview.update({ joint0: 90, joint1: 10 })
      const slide = new THREE.Box3().setFromObject(parent.getObjectByName('Slide')!).getCenter(new THREE.Vector3())
      expect(slide.x).toBeCloseTo(35, 3)
      const door = new THREE.Box3().setFromObject(parent.getObjectByName('Door')!).getCenter(new THREE.Vector3())
      expect(door.y).toBeCloseTo(10, 3)
      preview.update({ joint0: 0, joint1: 0 })
      expect(new THREE.Box3().setFromObject(parent.getObjectByName('Slide')!).getCenter(new THREE.Vector3()).x).toBeCloseTo(25, 3)
      preview.dispose()
    } finally { disposeModel(model.root) }
  }
})

it('uses a declared curve with joint limits and moves the same physical part', async () => {
  const model = await parseUsdModel(withMotionControls(validateUsd(robotUsd()), [
    { kind: 'curve', label: 'Open lid', axes: [{ joint: '/Model/DoorHinge', step: 0.5 }] },
  ]))
  try {
    expect(model.motionIssue).toBeUndefined()
    expect(model.motionDefinitions).toEqual([{ kind: 'curve', label: 'Open lid', axes: [{ key: 'joint0', min: 0, max: 90, step: 0.5, reset: 0 }] }])
    const parent = new THREE.Group(), preview = model.createMotionPreview(parent)
    preview.update({ joint0: 90 })
    const center = new THREE.Box3().setFromObject(parent.getObjectByName('Door')!).getCenter(new THREE.Vector3())
    expect(center.x).toBeCloseTo(15, 3)
    expect(center.y).toBeCloseTo(10, 3)
    preview.dispose()
  } finally { disposeModel(model.root) }
})

it.each([
  [[], '1–12'],
  [[{ kind: 'dial', label: 'Door', axes: [{ joint: '/Model/DoorHinge' }] }], 'slider, pad, or curve'],
  [[{ kind: 'pad', label: 'Door', axes: [{ joint: '/Model/DoorHinge' }] }], 'two axes'],
  [[{ kind: 'slider', label: 'Door', axes: [{ joint: '/Model/Missing' }] }], 'movable joint'],
  [[{ kind: 'slider', label: 'Door', axes: [{ joint: '/Model/DoorHinge', min: 10 }] }], 'limits and reset'],
  [[{ kind: 'slider', label: 'Door', axes: [{ joint: '/Model/DoorHinge', step: 100 }] }], 'Invalid control range'],
  [[{ kind: 'pad', label: 'Door', axes: [{ joint: '/Model/DoorHinge' }, { joint: '/Model/DoorHinge' }] }], 'more than once'],
])('keeps geometry visible with a diagnostic for invalid motion UI: %j', async (controls, message) => {
  const model = await parseUsdModel(withMotionControls(validateUsd(robotUsd()), controls))
  try {
    expect(model.positions.length).toBeGreaterThan(0)
    expect(model.motionDefinitions).toBeUndefined()
    expect(model.motionIssue).toContain(message)
  } finally { disposeModel(model.root) }
})

it('loads CAD USD geometry and derives its joint control from the Isaac relationships', async () => {
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

it('keeps legacy moving models inspectable while identifying their separate-printing requirement', async () => {
  const text = validateUsd(robotUsd()).replace('rumi:manufacturingMode = "separate"', 'rumi:manufacturingMode = "print-in-place"')
  const bytes = new TextEncoder().encode(text)
  expect(usdRequiresSeparatePrint(bytes)).toBe(true)
  expect(usdRequiresSeparatePrint(robotUsd())).toBe(false)
  const model = await parseUsdModel(bytes.buffer)
  try {
    expect(model.robot.assembly.manufacturing.mode).toBe('print-in-place')
    expect(model.motionDefinitions[0].axes[0]).toMatchObject({ min: 0, max: 90 })
  } finally { disposeModel(model.root) }
  expect(usdRequiresSeparatePrint(new TextEncoder().encode(text.replace('PhysicsRevoluteJoint', 'PhysicsFixedJoint')))).toBe(false)
})

it('parses fixed-joint rumi:retainer and lock axis metadata for bayonet and threaded retainers', async () => {
  const text = validateUsd(robotUsd())
    .replace('PhysicsRevoluteJoint "DoorHinge"', 'PhysicsFixedJoint "CapLock"')
    .replace('float physics:lowerLimit = 0\n', '')
    .replace('float physics:upperLimit = 90\n', '')
    .replace('string rumi:control = "Door"', 'token rumi:retainer = "bayonet"')
    .replace('rel isaac:physics:robotJoints = </Model/DoorHinge>', 'rel isaac:physics:robotJoints = </Model/CapLock>')
  const model = await parseUsdModel(new TextEncoder().encode(text).buffer)
  try {
    expect(model.motionIssue).toBeUndefined()
    expect(model.robot.assembly.connections).toEqual([{
      id: 'CapLock', parent: 'Body', child: 'Door', kind: 'fixed',
      retainer: 'bayonet', axis: [0, 0, 1], pivot: [15, 0, 0],
    }])
  } finally { disposeModel(model.root) }
})
