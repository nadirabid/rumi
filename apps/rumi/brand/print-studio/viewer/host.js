/**
 * The mesh preview capability: a session-owned scene, the routes the browser
 * reads it through, and the tools that edit it.
 *
 * Content and composition are separate. Opening a file stores a datablock —
 * geometry, its published bytes, and the centre its rotation turns around — and
 * places one object. Every later change is a scene command, so turning or
 * resizing never rewrites a mesh, and the browser renders the same geometry it
 * already fetched.
 */
import { basename, extname } from 'node:path'
import { analyzeMesh } from './checks.js'
import { createHistory } from './document.js'
import { STL_LIMITS, encodeStl, parseStl } from './stl.js'
import { placeMesh } from './transform.js'

const ROUTE = '/api/print-studio/viewer'
const JSON_HEADERS = { 'cache-control': 'private, no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }
/** A datablock never changes once opened, so its bytes stay cacheable for the page's lifetime. */
const MESH_HEADERS = { 'cache-control': 'private, max-age=3600, immutable', 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' }
const MAX_SESSIONS = 8

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/**
 * The one object a command means when the caller did not name one.
 * @param {object} record - Session record.
 * @param {string} intent - Tool name, for the failure message.
 * @returns {string} the only object's id.
 * @throws {Error} When the scene holds zero or several objects.
 */
/**
 * The datablock for one file, reusing the last one opened at that path when the
 * bytes are unchanged. Reopening a part therefore places a second object that
 * shares the geometry the browser already has.
 * @param {object} record - Session record.
 * @param {string} path - Path the bytes were read from.
 * @param {Float32Array} positions - Parsed geometry.
 * @param {ArrayBuffer} bytes - Canonical encoding sent to the browser.
 * @returns {string} the datablock id.
 */
function datablockFor(record, path, positions, bytes) {
  const existing = record.datablocks.get(record.byPath.get(path))
  if (existing !== undefined && sameBytes(existing.bytes, bytes)) return record.byPath.get(path)
  const id = crypto.randomUUID()
  record.datablocks.set(id, { name: basename(path), positions, bytes })
  record.byPath.set(path, id)
  return id
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function onlyObject(record, intent) {
  const { objects } = record.history.current()
  if (objects.length === 1) return objects[0].id
  throw new Error(`${intent} needs an objectId when the scene holds ${objects.length === 0 ? 'no objects' : `${objects.length} objects`}`)
}

/**
 * Measure one object as the scene composes it.
 * @param {object} record - Session record holding the datablocks.
 * @param {object} object - Scene object.
 * @returns {object} the analysis of the transformed mesh.
 */
function measureObject(record, object) {
  const datablock = record.datablocks.get(object.datablockId)
  const placed = placeMesh(datablock.positions, object.transform)
  return { matrix: placed.matrix, report: analyzeMesh(placed.positions, { volume: record.history.current().volume }) }
}

/**
 * Re-measure the objects a command changed.
 * @param {object} record - Session record.
 * @param {string[]} [objectIds] - Objects to re-measure; omitted re-measures the whole scene.
 * @returns {void}
 */
function refresh(record, objectIds) {
  const { objects } = record.history.current()
  for (const object of objects) {
    if (objectIds !== undefined && !objectIds.includes(object.id)) continue
    record.measurements.set(object.id, measureObject(record, object))
  }
  for (const id of [...record.measurements.keys()]) {
    if (!objects.some(object => object.id === id)) record.measurements.delete(id)
  }
}

function summaryOf(record) {
  const measured = [...record.measurements.values()].map(measurement => measurement.report)
  const errors = measured.reduce((total, report) => total + report.checks.filter(check => check.severity === 'error').length, 0)
  const warnings = measured.reduce((total, report) => total + report.checks.filter(check => check.severity === 'warning').length, 0)
  return { status: errors > 0 ? 'blocked' : warnings > 0 ? 'review' : 'ok', errors, warnings }
}

/**
 * What the browser needs to draw the scene: placement matrices, statuses, and
 * no measurements.
 * @param {object} record - Session record.
 * @returns {object} the view state.
 */
function sceneState(record) {
  const scene = record.history.current()
  return {
    revision: scene.revision,
    volume: scene.volume,
    summary: summaryOf(record),
    objects: scene.objects.map((object) => {
      const measurement = record.measurements.get(object.id)
      return {
        id: object.id,
        datablockId: object.datablockId,
        name: object.name,
        visible: object.visible,
        matrix: measurement.matrix,
        blocked: measurement.report.status === 'blocked',
      }
    }),
  }
}

/**
 * What an agent needs to talk about the scene: placements and measurements.
 * @param {object} record - Session record.
 * @returns {object} the report.
 */
function sceneReport(record) {
  const scene = record.history.current()
  return {
    volume: scene.volume,
    objectCount: scene.objects.length,
    ...summaryOf(record),
    objects: scene.objects.map((object) => {
      const { report } = record.measurements.get(object.id)
      return {
        id: object.id,
        name: object.name,
        datablockId: object.datablockId,
        visible: object.visible,
        transform: object.transform,
        dimensions: report.dimensions,
        status: report.status,
        suggested: report.suggested,
        checks: report.checks,
      }
    }),
  }
}

/**
 * Register the preview routes and the scene tools.
 * @param {object} ctx - Cordis host context with connection, tools, fs, and workingDirectory.
 * @param {Function} defineTool - DSH's schema-validating tool factory from the host entrypoint.
 * @returns {void}
 */
export function applyViewer(ctx, defineTool) {
  const sessions = new Map()
  let closed = false
  ctx.effect(() => () => { closed = true; sessions.clear() }, 'print-studio: preview scenes')
  const route = (path, fetch) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods: ['GET'], requestBody: 'buffered', fetch,
  }), `print-studio: preview ${path || 'state'}`)

  /**
   * The session's scene record, created on first use and dropped least recently used.
   * @param {string} sessionId - Conversation id.
   * @returns {object} the record.
   */
  function recordFor(sessionId) {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      sessions.delete(sessionId)
      sessions.set(sessionId, existing)
      return existing
    }
    const record = { history: createHistory(), datablocks: new Map(), byPath: new Map(), measurements: new Map() }
    sessions.set(sessionId, record)
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
    return record
  }

  route('/state', async (request) => {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (!sessionId) return json({ error: 'session_required' }, 400)
    return json({ scene: sceneState(recordFor(sessionId)) })
  })

  route('/model', async (request) => {
    const query = new URL(request.url).searchParams
    const sessionId = query.get('sessionId')
    const datablock = sessionId === null ? undefined : sessions.get(sessionId)?.datablocks.get(query.get('datablockId'))
    if (datablock === undefined) return json({ error: 'preview_not_found' }, 404)
    return new Response(datablock.bytes.slice(0), { headers: MESH_HEADERS })
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_state',
    description: 'Read the 3D preview scene without changing it: every object, its placement, and the measurements of its composed mesh. '
      + 'The scene is held in memory for the conversation, so it is empty after Rumi restarts; read it instead of assuming what is on screen.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      return JSON.stringify(sceneReport(recordFor(agent.session.id)), undefined, 2)
    },
  })), 'print-studio: read scene tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_open',
    description: 'Open an STL into this conversation’s 3D preview and place it on the plate. Coordinates are millimetres, Z up. '
      + 'Opening the same file again places a second copy: the scene holds objects that share mesh geometry. '
      + 'Pass `buildVolume` when the scene is headed for a printer; fit checks then use it and the preview draws it as a plate. '
      + 'Every check is a measurement. None of them establish print readiness.',
    parameters: {
      path: { type: 'string', required: true, description: 'STL path in the session workspace, or an absolute path.' },
      buildVolume: {
        type: 'object', additionalProperties: false,
        description: 'Printable volume in millimetres for this scene. Omit for a mesh that is only being looked at.',
        properties: {
          x: { type: 'number', required: true, description: 'Width in millimetres.' },
          y: { type: 'number', required: true, description: 'Depth in millimetres.' },
          z: { type: 'number', required: true, description: 'Height in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('mesh_open requires a file path')
      if (extname(args.path).toLowerCase() !== '.stl') throw new Error('mesh_open accepts an STL file')
      const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const source = await ctx.fs.readBytes(target, exec.signal, STL_LIMITS.maxBytes)
      const positions = parseStl(source)
      exec.signal.throwIfAborted()
      if (closed) throw new Error('Mesh preview is closed')
      const record = recordFor(agent.session.id)
      if (args.buildVolume !== undefined) record.history.apply({ type: 'setVolume', volume: args.buildVolume })
      const datablockId = datablockFor(record, target.displayPath ?? args.path, positions, encodeStl(positions))
      const scene = record.history.apply({ type: 'addObject', datablockId, name: basename(args.path) })
      refresh(record, [scene.objects.at(-1).id])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: open mesh tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_transform',
    description: 'Place one object in the 3D preview: uniform scale, rotation in degrees about the object’s centre, and position in millimetres. '
      + 'Each part you pass replaces that part and the rest is kept, so a scale stays when you only rotate. '
      + 'This never rewrites the mesh or the file; the scene holds the placement until it is baked for printing. '
      + 'Omit `objectId` when the scene holds exactly one object.',
    parameters: {
      objectId: { type: 'string', description: 'Object to place; defaults to the only object in the scene.' },
      scale: { type: 'number', description: 'Uniform scale greater than zero.' },
      rotate: {
        type: 'object', additionalProperties: false,
        description: 'Rotation in degrees about each axis, applied X then Y then Z, around the object’s centre.',
        properties: {
          x: { type: 'number', description: 'Rotation about X in degrees.' },
          y: { type: 'number', description: 'Rotation about Y in degrees.' },
          z: { type: 'number', description: 'Rotation about Z in degrees.' },
        },
      },
      position: {
        type: 'object', additionalProperties: false,
        description: 'Offset in millimetres on each axis, replacing the current offset.',
        properties: {
          x: { type: 'number', description: 'X offset in millimetres.' },
          y: { type: 'number', description: 'Y offset in millimetres.' },
          z: { type: 'number', description: 'Z offset in millimetres.' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_transform')
      record.history.apply({ type: 'setTransform', objectId, scale: args.scale, rotate: args.rotate, position: args.position })
      refresh(record, [objectId])
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: place mesh tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mesh_remove',
    description: 'Remove one object from the 3D preview. The mesh geometry stays available to the session, so opening the file again does not read it twice.',
    parameters: {
      objectId: { type: 'string', description: 'Object to remove; defaults to the only object in the scene.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    timeoutMs: 15_000,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Mesh preview requires a conversation')
      const record = recordFor(agent.session.id)
      const objectId = args.objectId ?? onlyObject(record, 'mesh_remove')
      record.history.apply({ type: 'removeObject', objectId })
      refresh(record)
      return JSON.stringify(sceneReport(record), undefined, 2)
    },
  })), 'print-studio: remove mesh tool')
}
