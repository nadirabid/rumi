/** Load the canonical USD robot into Three.js and project its joints into preview controls. */
import * as THREE from 'three'
import { USDLoader } from 'three/addons/loaders/USDLoader.js'
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js'
import { validateUsd } from '../usd.js'
import { validateRobotAssembly } from '../mechanics.js'
import { buildModel } from './model.js'
import { robotMotion } from './assembly-motion.js'

function robotDescription(specs, objects) {
  const fields = specs['/']?.fields
  if (fields?.upAxis !== 'Z' || fields?.metersPerUnit !== 1) throw new Error('Publish robot USD in metres with Z up')
  const root = `/${fields.defaultPrim}`
  const attribute = (path, name, fallback) => {
    const field = specs[`${path}.${name}`]?.fields
    if (!field || field.default === undefined) return fallback
    if (field.typeName === 'bool') {
      if (['true', '1', true, 1].includes(field.default)) return true
      if (['false', '0', false, 0].includes(field.default)) return false
      throw new Error('USD boolean attribute must be true or false')
    }
    return field.default
  }
  // Three's USDA parser retains multi-target relationship arrays as one bracketed string.
  const targets = (path, name) => (specs[`${path}.${name}`]?.fields.targetPaths ?? [])
    .flatMap(value => value.startsWith('[') ? value.slice(1, -1).split(',').map(path => path.trim()).filter(Boolean) : [value])
    .filter(path => path !== 'None')
  const hasSchema = (path, schema) => {
    const value = attribute(path, 'apiSchemas', '[]')
    return (Array.isArray(value) ? value : JSON.parse(value)).includes(schema)
  }
  if (!hasSchema(root, 'IsaacRobotAPI')) throw new Error('USD default prim requires IsaacRobotAPI')
  const meshes = Object.entries(specs).filter(([, spec]) => spec.specType === 6 && spec.fields.typeName === 'Mesh').map(([path]) => path)
  const links = targets(root, 'isaac:physics:robotLinks')
  const joints = targets(root, 'isaac:physics:robotJoints')
  if (!links.length || links.length !== meshes.length || new Set(links).size !== links.length || meshes.some(path => !links.includes(path))) {
    throw new Error('Isaac robotLinks must include each physical mesh exactly once')
  }
  const physicsJoints = Object.entries(specs).filter(([, spec]) => spec.specType === 6 && /^Physics.*Joint$/.test(spec.fields.typeName)).map(([path]) => path)
  if (new Set(joints).size !== joints.length || physicsJoints.length !== joints.length || physicsJoints.some(path => !joints.includes(path))) {
    throw new Error('Isaac robotJoints must include every physics joint exactly once')
  }
  const name = path => path.split('/').at(-1)
  for (const path of links) {
    if (!['IsaacLinkAPI', 'PhysicsRigidBodyAPI', 'PhysicsCollisionAPI'].every(schema => hasSchema(path, schema))) {
      throw new Error('Each robot link needs IsaacLinkAPI, rigid body and collision schemas')
    }
    if (!attribute(path, 'physics:rigidBodyEnabled', true) || !attribute(path, 'physics:collisionEnabled', true) || attribute(path, 'physics:kinematicEnabled', false)) {
      throw new Error('Robot links require enabled dynamic rigid bodies and collisions')
    }
  }
  const kinds = { PhysicsFixedJoint: 'fixed', PhysicsRevoluteJoint: 'revolute', PhysicsPrismaticJoint: 'prismatic' }
  const connections = joints.map(path => {
    const kind = kinds[specs[path]?.fields.typeName]
    if (!kind || !hasSchema(path, 'IsaacJointAPI')) throw new Error('Unsupported USD robot joint')
    const parents = targets(path, 'physics:body0'), children = targets(path, 'physics:body1')
    if (parents.length !== 1 || children.length !== 1 || !links.includes(parents[0]) || !links.includes(children[0])) {
      throw new Error('Joint body0 and body1 must each target one robot link')
    }
    if (attribute(path, 'physics:jointEnabled', true) === false) throw new Error('Disabled joint cannot describe a required connection')
    const connection = { id: name(path), parent: name(parents[0]), child: name(children[0]), kind }
    const frames = [parents[0], children[0]].map((body, index) => {
      const object = objects.get(body)
      if (!object) throw new Error('Joint body mesh is not loaded')
      const position = attribute(path, `physics:localPos${index}`, [0, 0, 0])
      const rotation = attribute(path, `physics:localRot${index}`, [0, 0, 0, 1])
      if (position.length !== 3 || rotation.length !== 4 || ![...position, ...rotation].every(Number.isFinite)) throw new Error('Joint frames must be finite')
      const quaternion = new THREE.Quaternion(...rotation)
      if (Math.abs(quaternion.length() - 1) > .00001) throw new Error('Joint frame rotations must be unit quaternions')
      return { object, quaternion, pivot: new THREE.Vector3(...position).applyMatrix4(object.matrixWorld) }
    })
    if (frames[0].pivot.distanceTo(frames[1].pivot) > .001) throw new Error('Joint body frames must meet at the saved rest pose')
    if (kind === 'fixed') {
      for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const directions = frames.map(frame => new THREE.Vector3(...axis).applyQuaternion(frame.quaternion).transformDirection(frame.object.matrixWorld))
        if (directions[0].distanceTo(directions[1]) > .00001) throw new Error('Fixed joint body frame rotations must agree at the saved rest pose')
      }
      return connection
    }
    const parent = frames[0].object
    const axisName = attribute(path, 'physics:axis', 'X')
    const axis = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[axisName]
    if (!axis) throw new Error('Joint axis must be X, Y or Z')
    const axes = frames.map(frame => new THREE.Vector3(...axis).applyQuaternion(frame.quaternion).transformDirection(frame.object.matrixWorld))
    if (axes[0].distanceTo(axes[1]) > .00001) throw new Error('Joint body frame axes must agree at the saved rest pose')
    const scale = kind === 'prismatic' ? 1000 : 1
    return { ...connection,
      axis: axes[0].toArray(),
      pivot: new THREE.Vector3(...attribute(path, 'physics:localPos0', [0, 0, 0])).applyMatrix4(parent.matrixWorld).toArray(),
      range: [attribute(path, 'physics:lowerLimit', -Infinity) * scale, attribute(path, 'physics:upperLimit', Infinity) * scale],
      ...(attribute(path, 'rumi:control') === undefined ? {} : { control: attribute(path, 'rumi:control') }),
    }
  })
  const steps = attribute(root, 'rumi:disassembly')
  return { assembly: { version: 1, root: name(links[0]), parts: links.map(path => ({ id: name(path), mesh: name(path) })),
    connections, sequences: JSON.parse(attribute(root, 'rumi:sequences', '[]')),
    manufacturing: { mode: attribute(root, 'rumi:manufacturingMode', 'print-in-place'), ...(steps === undefined ? {} : { steps: JSON.parse(steps) }) } },
  nodes: meshes.map((path, mesh) => ({ name: name(path), mesh })) }
}

/** Parse a self-contained robot USD; malformed joints remain visible but cannot create controls.
 * @param {ArrayBuffer} buffer Immutable ASCII USD bytes.
 * @returns {Promise<object>} Owned millimetre/Z-up model with optional movement controls.
 */
export async function parseUsdModel(buffer) {
  const text = validateUsd(new Uint8Array(buffer))
  const specs = new USDAParser().parseData(text).specsByPath
  const scene = new USDLoader().parse(text)
  scene.userData.rumiCoordinateFrame = true
  const root = new THREE.Group()
  root.userData.rumiCoordinateFrame = true
  root.rotation.x = Math.PI / 2
  root.scale.setScalar(1000)
  root.add(scene)
  root.traverse(node => { if (node.type === 'Object3D') node.isGroup = true })
  root.updateMatrixWorld(true)
  const objects = new Map()
  function collect(parent, prefix) {
    for (const child of parent.children) {
      const path = `${prefix}/${child.name}`
      objects.set(path, child)
      collect(child, path)
    }
  }
  collect(scene, '')
  let model
  try {
    model = buildModel(() => root)
    const description = robotDescription(specs, objects)
    const metadata = validateRobotAssembly(description)
    const nodeIndices = new Map(description.nodes.map((node, index) => {
      const path = [...objects.keys()].find(path => objects.get(path).isMesh && objects.get(path).name === node.name)
      return [objects.get(path), index]
    }))
    return { ...model, robot: metadata, ...robotMotion(metadata, description.nodes, root, nodeIndices) }
  } catch (error) {
    if (model) return { ...model, motionIssue: error.message }
    throw error
  }
}
