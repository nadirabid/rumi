/** Assembly descriptions bind movement intent to every exported physical mesh. */
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const range = (value, cap) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] <= 0 && value[1] >= 0 && value[0] < value[1] && value.every(item => Math.abs(item) <= cap)

/**
 * Parse model-owned assembly metadata against the complete exported mesh inventory.
 * A uniquely named static mesh receives a one-part description for solid validation.
 * Multi-part or movable models and legacy declarations require an explicit assembly.
 * Control origins preserve absolute ranges across saved poses; absent origins retain
 * legacy relative-only intent. Unsupported physics remains the runner's responsibility.
 * @param {object} manifest Validated glTF manifest; mesh nodes retain unique source names.
 * @returns Normalized assembly, motion coverage, and blocking declaration findings.
 */
export function mechanismMetadata(manifest) {
  return validateRobotAssembly({
    assembly: manifest.asset?.extras?.rumiAssembly,
    nodes: manifest.nodes,
    motionKeys: manifest.asset?.extras?.rumiMotionKeys,
    motionRanges: manifest.asset?.extras?.rumiMotionRanges,
    legacy: manifest.asset?.extras?.rumiMechanisms,
  })
}

/** Validate a solver-neutral projection of USD robot bodies and joints.
 * @param {object} description Parsed robot, mesh inventory and optional movement intent.
 * @returns {object} Bounded assembly and blocking findings for unsupported declarations.
 */
export function validateRobotAssembly(description) {
  const extras = { rumiAssembly: description.assembly, rumiMotionKeys: description.motionKeys,
    rumiMotionRanges: description.motionRanges, rumiMechanisms: description.legacy }
  let raw = extras.rumiAssembly
  const nodes = Array.isArray(description.nodes) ? description.nodes : []
  const meshes = nodes.filter(node => Number.isSafeInteger(node?.mesh) && node.mesh >= 0)
  const motionKeys = extras.rumiMotionKeys === undefined ? [] : extras.rumiMotionKeys
  const motionRanges = extras.rumiMotionRanges === undefined ? [] : extras.rumiMotionRanges
  const checks = [], ranges = new Map()
  const issue = (message, code = 'assembly_description_invalid') => {
    if (checks.length < 32) checks.push({ code, severity: 'error', count: 1, message })
  }
  if (!Array.isArray(motionKeys) || motionKeys.length > 24 || motionKeys.some(key => !name(key))
    || new Set(motionKeys).size !== motionKeys.length) issue('Movement control keys must be unique names, at most 24.')
  if (!Array.isArray(motionRanges) || motionRanges.length > 24) issue('Movement control ranges must be a bounded list.')
  else for (const item of motionRanges) {
    if (!object(item) || !name(item.key) || ranges.has(item.key) || !range(item.range, 1000)
      || (item.origin !== undefined && (!Number.isFinite(item.origin)
        || !item.range.every(value => Number.isFinite(value + item.origin))
        || item.range[0] + item.origin >= item.range[1] + item.origin))) {
      issue('Each movement control needs a finite saved-relative range and, when supplied, a finite saved-value origin.')
    } else ranges.set(item.key, { range: [...item.range], ...(item.origin === undefined ? {} : { origin: item.origin }) })
  }
  const keys = new Set([...(Array.isArray(motionKeys) ? motionKeys.filter(name) : []), ...ranges.keys()])
  const result = assembly => ({ declared: true, assembly, mechanisms: assembly?.connections.filter(item => item.kind !== 'fixed') ?? [],
    motionKeys: [...keys], motionRanges: [...ranges].map(([key, value]) => ({ key, ...value })), checks })
  if (raw === undefined) {
    const mesh = meshes[0]
    if (!checks.length && !keys.size && extras.rumiMechanisms === undefined && meshes.length === 1
      && name(mesh.name) && nodes.filter(node => node?.name === mesh.name).length === 1) {
      raw = { version: 1, root: mesh.name, parts: [{ id: mesh.name, mesh: mesh.name }], connections: [], manufacturing: { mode: 'print-in-place' } }
    } else {
      issue('Publish USD with IsaacRobotAPI, IsaacLinkAPI and IsaacJointAPI covering every physical mesh and connection.', 'assembly_description_required')
      return result(null)
    }
  }
  if (!object(raw) || raw.version !== 1 || !name(raw.root) || !Array.isArray(raw.parts) || !raw.parts.length
    || raw.parts.length > 128 || !Array.isArray(raw.connections) || raw.connections.length > 128
    || !object(raw.manufacturing) || !['print-in-place', 'separate'].includes(raw.manufacturing.mode)) {
    issue('Assembly version 1 requires a root, 1–128 parts, at most 128 connections, and manufacturing.mode print-in-place or separate.')
    return result(null)
  }
  const parts = [], ids = new Set(), meshNames = new Set()
  for (const part of raw.parts) {
    if (!object(part) || !name(part.id) || !name(part.mesh) || ids.has(part.id) || meshNames.has(part.mesh)) {
      issue('Assembly parts require unique id and mesh names.'); continue
    }
    ids.add(part.id); meshNames.add(part.mesh); parts.push({ id: part.id, mesh: part.mesh })
    const matches = nodes.filter(node => node?.name === part.mesh)
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].mesh) || matches[0].mesh < 0) {
      issue(`Part ${part.id} must reference exactly one exported mesh node named ${part.mesh}.`)
    }
  }
  if (meshes.length !== parts.length || meshes.some(node => !meshNames.has(node.name))) {
    issue('Every exported mesh node must belong to exactly one assembly part.', 'assembly_mesh_unmapped')
  }
  if (!ids.has(raw.root)) issue('The assembly root must name an existing physical part.')
  const RETAINERS = ['rigid', 'bayonet', 'threaded', 'snap', 'friction']
  const connections = [], connectionIds = new Set(), adjacent = new Map(parts.map(part => [part.id, []]))
  for (const connection of raw.connections) {
    if (!object(connection) || !name(connection.id) || connectionIds.has(connection.id)
      || !ids.has(connection.parent) || !ids.has(connection.child) || connection.parent === connection.child
      || !['fixed', 'revolute', 'prismatic'].includes(connection.kind)) {
      issue('Each connection needs a unique id, two distinct existing parts and a supported joint kind.'); continue
    }
    connectionIds.add(connection.id)
    adjacent.get(connection.parent).push(connection.child)
    if (connection.kind === 'fixed') {
      if (connection.control !== undefined) issue(`Fixed connection ${connection.id} cannot bind a movement control.`)
      const retainer = connection.retainer
      if (retainer !== undefined && !RETAINERS.includes(retainer)) {
        issue(`Fixed connection ${connection.id} uses unsupported retainer "${retainer}".`); continue
      }
      const needsAxis = retainer === 'bayonet' || retainer === 'threaded'
      let normalizedAxis
      if (needsAxis || connection.axis !== undefined) {
        const length = vector(connection.axis) ? Math.hypot(...connection.axis) : NaN
        if (!Number.isFinite(length) || length < 1e-6) {
          issue(`Fixed connection ${connection.id} with retainer "${retainer ?? 'rigid'}" requires a nonzero finite axis.`); continue
        }
        normalizedAxis = connection.axis.map(value => value / length)
      }
      if (connection.pivot !== undefined && !vector(connection.pivot)) {
        issue(`Fixed connection ${connection.id} pivot must be a finite three-coordinate vector.`); continue
      }
      connections.push({
        id: connection.id, parent: connection.parent, child: connection.child, kind: 'fixed',
        ...(retainer === undefined ? {} : { retainer }),
        ...(normalizedAxis === undefined ? {} : { axis: normalizedAxis }),
        ...(connection.pivot === undefined ? {} : { pivot: [...connection.pivot] }),
      })
      continue
    }
    if (connection.retainer !== undefined) {
      issue(`Movable connection ${connection.id} cannot declare a fixed retainer.`); continue
    }
    const length = vector(connection.axis) ? Math.hypot(...connection.axis) : NaN
    if (!Number.isFinite(length) || length < 1e-6 || !vector(connection.pivot)
      || !range(connection.range, connection.kind === 'revolute' ? 180 : 1000)
      || (connection.control !== undefined && !name(connection.control))) {
      issue(`Connection ${connection.id} needs a nonzero axis, finite pivot and nonempty range containing zero.`); continue
    }
    connections.push({ id: connection.id, parent: connection.parent, child: connection.child, kind: connection.kind,
      axis: connection.axis.map(value => value / length), pivot: [...connection.pivot], range: [...connection.range],
      ...(connection.control === undefined ? {} : { control: connection.control }) })
  }
  const reached = new Set(), pending = [raw.root]
  while (pending.length) {
    const id = pending.pop()
    if (reached.has(id)) continue
    reached.add(id); pending.push(...(adjacent.get(id) ?? []))
  }
  if (parts.some(part => !reached.has(part.id))) issue('Every physical part requires a directed parent-to-child connection path from the assembly root.', 'assembly_part_disconnected')
  for (const key of keys) {
    const bound = connections.filter(item => item.control === key)
    if (!bound.length) issue(`Movement control ${key} needs a matching assembly connection.`, 'mechanism_declaration_missing')
    else {
      const controlRange = ranges.get(key)?.range
      if (!controlRange) issue(`Movement control ${key} needs its full range relative to the saved value.`)
      else for (const connection of bound) if (connection.range[0] > controlRange[0] || connection.range[1] < controlRange[1]) {
        issue(`Connection ${connection.id} must cover movement control ${key}'s saved-relative range [${controlRange.join(', ')}].`, 'mechanism_control_range_uncovered')
      }
    }
  }
  const sequences = [], sequenceIds = new Set(); let waypointCount = 0
  if (raw.sequences !== undefined) {
    if (!Array.isArray(raw.sequences) || raw.sequences.length > 32) issue('Assembly sequences must contain at most 32 named sequences.')
    else for (const sequence of raw.sequences) {
      if (!object(sequence) || !name(sequence.id) || sequenceIds.has(sequence.id) || !Array.isArray(sequence.waypoints)
        || !sequence.waypoints.length || sequence.waypoints.length > 64) {
        issue('Each assembly sequence needs a unique id and 1–64 waypoints.'); continue
      }
      sequenceIds.add(sequence.id); waypointCount += sequence.waypoints.length
      const waypoints = []
      for (const waypoint of sequence.waypoints) {
        if (!object(waypoint) || !Object.keys(waypoint).length) { issue(`Sequence ${sequence.id} contains an empty or invalid waypoint.`); continue }
        const entries = Object.entries(waypoint)
        for (const [id, value] of entries) {
          const connection = connections.find(item => item.id === id)
          if (!connection || connection.kind === 'fixed' || !Number.isFinite(value)
            || value < connection.range[0] || value > connection.range[1]) issue(`Sequence ${sequence.id} requires in-range targets for existing movable connections.`)
        }
        waypoints.push(Object.fromEntries(entries))
      }
      sequences.push({ id: sequence.id, waypoints })
    }
  }
  if (waypointCount > 256) issue('Assembly sequences exceed the 256-waypoint limit.')
  const manufacturing = { mode: raw.manufacturing.mode }
  if (raw.manufacturing.steps !== undefined) {
    const steps = raw.manufacturing.steps, removed = new Set(), normalized = []; let points = 0
    if (manufacturing.mode !== 'separate' || !Array.isArray(steps) || steps.length > 127) {
      issue('Only separate assemblies may declare at most 127 disassembly steps.')
    } else for (const step of steps) {
      if (!object(step) || !ids.has(step.part) || step.part === raw.root || removed.has(step.part)) {
        issue('Each disassembly step needs a distinct nonroot part and either a path or actions list.'); continue
      }
      const hasPath = step.path !== undefined, hasActions = step.actions !== undefined
      if (hasPath === hasActions) {
        issue('Each disassembly step must declare either path or actions.'); continue
      }
      if (Object.keys(step).some(key => !['part', hasPath ? 'path' : 'actions'].includes(key))) {
        issue('Disassembly steps support only part with path or actions; other route properties are unsupported.', 'assembly_route_unsupported'); continue
      }
      if (hasPath) {
        if (!Array.isArray(step.path) || step.path.length < 2 || step.path.length > 64
          || step.path.some(point => !vector(point) || point.some(value => Math.abs(value) > 10000))
          || step.path[0].some(value => value !== 0)) {
          issue('Each disassembly path needs 2–64 finite offset vectors starting at [0,0,0].'); continue
        }
        removed.add(step.part); points += step.path.length
        normalized.push({ part: step.part, path: step.path.map(point => [...point]) })
        continue
      }
      if (!Array.isArray(step.actions) || !step.actions.length || step.actions.length > 64) {
        issue('Each disassembly actions list needs 1–64 valid actions.'); continue
      }
      const actions = []; let validStep = true
      for (const action of step.actions) {
        if (!object(action) || typeof action.kind !== 'string') {
          issue('Each disassembly action must be an object with a supported kind.'); validStep = false; break
        }
        if (action.kind === 'translate') {
          if (Object.keys(action).some(key => !['kind', 'delta'].includes(key))) {
            issue('Translate actions support only kind and delta.', 'assembly_route_unsupported'); validStep = false; break
          }
          if (!vector(action.delta) || action.delta.some(value => Math.abs(value) > 10000)) {
            issue('Translate actions require a finite delta vector within ±10000 mm.'); validStep = false; break
          }
          actions.push({ kind: 'translate', delta: [...action.delta] })
        } else if (action.kind === 'rotate') {
          if (Object.keys(action).some(key => !['kind', 'pivot', 'axis', 'degrees', 'pitchMm'].includes(key))) {
            issue('Rotate actions support only kind, pivot, axis, degrees and optional pitchMm.', 'assembly_route_unsupported'); validStep = false; break
          }
          const axisLen = vector(action.axis) ? Math.hypot(...action.axis) : NaN
          const pitchMm = action.pitchMm === undefined ? 0 : action.pitchMm
          if (!vector(action.pivot) || action.pivot.some(value => Math.abs(value) > 1000000)
            || !Number.isFinite(axisLen) || axisLen < 1e-6
            || !Number.isFinite(action.degrees) || Math.abs(action.degrees) < 1e-6 || Math.abs(action.degrees) > 3600
            || !Number.isFinite(pitchMm) || Math.abs(pitchMm) > 1000) {
            issue('Rotate actions require finite pivot, nonzero axis, nonzero degrees within ±3600 and pitchMm within ±1000.'); validStep = false; break
          }
          actions.push({
            kind: 'rotate', pivot: [...action.pivot], axis: action.axis.map(value => value / axisLen),
            degrees: action.degrees, pitchMm,
          })
        } else if (action.kind === 'snap') {
          if (Object.keys(action).some(key => !['kind', 'delta', 'maxInterferenceMm', 'mate'].includes(key))) {
            issue('Snap actions support only kind, delta, maxInterferenceMm and optional mate.', 'assembly_route_unsupported'); validStep = false; break
          }
          const deltaLen = vector(action.delta) ? Math.hypot(...action.delta) : NaN
          if (!Number.isFinite(deltaLen) || deltaLen < 1e-6 || action.delta.some(value => Math.abs(value) > 10000)
            || !Number.isFinite(action.maxInterferenceMm) || action.maxInterferenceMm <= 0 || action.maxInterferenceMm > 2.5
            || (action.mate !== undefined && (!ids.has(action.mate) || action.mate === step.part))) {
            issue('Snap actions require a nonzero delta within ±10000 mm, 0 < maxInterferenceMm <= 2.5, and an optional distinct mating part.'); validStep = false; break
          }
          actions.push({
            kind: 'snap', delta: [...action.delta], maxInterferenceMm: action.maxInterferenceMm,
            ...(action.mate === undefined ? {} : { mate: action.mate }),
          })
        } else {
          issue(`Unsupported disassembly action kind "${action.kind}".`, 'assembly_route_unsupported'); validStep = false; break
        }
      }
      if (!validStep) continue
      removed.add(step.part); points += actions.length
      normalized.push({ part: step.part, actions })
    }
    if (points > 512) issue('Disassembly paths exceed the 512-point limit.')
    if (parts.some(part => part.id !== raw.root && !removed.has(part.id))) issue('Disassembly steps must remove every nonroot physical part.')
    manufacturing.steps = normalized
  }
  return result(checks.length ? null : { version: 1, root: raw.root, parts, connections, sequences, manufacturing })
}

/**
 * Add model-owned movement metadata without changing any GLB geometry chunks.
 * @param {ArrayBuffer} bytes Self-contained GLB from the model exporter.
 * @param {object} metadata JSON values to merge into asset.extras.
 * @returns {ArrayBuffer} A complete GLB with updated lengths and JSON padding.
 */
export function withMechanismMetadata(bytes, metadata) {
  const original = new Uint8Array(bytes), view = new DataView(bytes)
  const jsonLength = view.getUint32(12, true)
  const manifest = JSON.parse(new TextDecoder().decode(original.subarray(20, 20 + jsonLength)))
  manifest.asset.extras = { ...manifest.asset.extras, ...metadata }
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  const paddedLength = Math.ceil(json.length / 4) * 4
  const tail = original.subarray(20 + jsonLength)
  const result = new Uint8Array(20 + paddedLength + tail.length), header = new DataView(result.buffer)
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, result.length, true)
  header.setUint32(12, paddedLength, true); header.setUint32(16, 0x4e4f534a, true)
  result.fill(32, 20, 20 + paddedLength); result.set(json, 20); result.set(tail, 20 + paddedLength)
  return result.buffer
}
