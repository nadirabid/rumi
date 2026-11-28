/**
 * Passive, composable classifier mapping agent tool activity to viewer visual states.
 *
 * Observes session and agent lifecycle events without altering agent execution, prompts,
 * or tool behavior. Classifier rules are pure functions returning a semantic visual stage
 * or null when a call is housekeeping that should preserve the active visual state.
 */

/** Canonical visual stages supported by the 3D viewport activity layer. */
export const VIEWER_ACTIVITIES = Object.freeze([
  'idle',
  'building',
  'checking',
  'sculpt',
  'regions',
  'collision',
  'fdm',
  'mechanics',
  'look',
  'controls',
])

const VALID_STAGES = new Set(VIEWER_ACTIVITIES.filter(stage => stage !== 'idle'))

const SKILL_STAGE = Object.freeze({
  'cad-modeling': 'sculpt',
  'blender-modeling': 'sculpt',
  'name-model-regions': 'regions',
  'fdm-design': 'fdm',
  'printable-joints': 'mechanics',
  joints: 'mechanics',
  'mesh-edit-controls': 'controls',
  'built-in-mesh-operations': 'controls',
  'analog-shaping': 'controls',
  'interactive-controls': 'controls',
  'clarify-mesh-changes': 'look',
})

const DIRECT_TOOL_STAGE = Object.freeze({
  viewer_analyze_surfaces: 'regions',
  validation_assembly: 'collision',
  validation_geometry: 'fdm',
  validation_fit: 'fdm',
  validation_mechanics: 'mechanics',
  print_studio_compare_mechanics: 'mechanics',
  validation_snapshot: 'checking',
  validation_accept: 'checking',
  viewer_controls: 'controls',
  viewer_shape_controls: 'controls',
  viewer_camera: 'look',
  viewer_cursor_snapshot: 'look',
  viewer_load: 'sculpt',
  viewer_transform: 'sculpt',
  mesh_open: 'sculpt',
  mesh_transform: 'sculpt',
  viewer_propose_edit: 'look',
})

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_error) {
    // Streaming or malformed tool JSON degrades to empty arguments rather than throwing.
    return {}
  }
}

function filePathOf(args) {
  return String(args.path ?? args.file_path ?? '').toLowerCase()
}

function basenameOf(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/** Classify dedicated Print Studio, viewer, and validation tools directly. */
export function classifyDedicatedTool({ name, args }) {
  if (Object.hasOwn(DIRECT_TOOL_STAGE, name)) return DIRECT_TOOL_STAGE[name]
  if (name === 'viewer_highlight') return args.regionId || args.regionName ? 'regions' : 'look'
  if (name === 'skill') {
    const skillName = String(args.name ?? args.skill ?? '').trim()
    return Object.hasOwn(SKILL_STAGE, skillName) ? SKILL_STAGE[skillName] : null
  }
  return null
}

/** Classify visual inspection calls (`read_image`) by the target image role. */
export function classifyImageInspection({ name, args }) {
  if (name !== 'read_image') return null
  const path = filePathOf(args)
  if (/region|audit|label|segment/.test(path)) return 'regions'
  if (/clearance|collision|gap|overlap|intersect|joint|hinge|axle|cross.?section/.test(path)) return 'collision'
  return 'look'
}

/** Classify file write/edit calls targeting model scripts, region maps, controls, or checks. */
export function classifyFileEdit({ name, args }) {
  if (name !== 'write' && name !== 'edit' && name !== 'apply_patch') return null
  const path = filePathOf(args)
  if (!path) return null
  if (/region/.test(path)) return 'regions'
  if (/control|field/.test(path)) return 'controls'
  if (/render|preview|snap|camera|view/.test(path)) return 'look'
  if (/collision|clearance|overlap|intersect/.test(path)) return 'collision'
  if (/validate|fdm|print3d|overhang|manifold/.test(path)) return 'fdm'
  if (/\.(py|usda?|stl|mjs|js)$/.test(path)) return 'sculpt'
  return null
}

/** Classify shell commands (CAD Python runs, validation checks, renders) while absorbing plumbing. */
export function classifyShellCommand({ name, args }) {
  if (name !== 'bash' && name !== 'shell' && name !== 'exec_command') return null
  const cmd = String(args.command ?? args.cmd ?? '').trim()
  if (!cmd) return null
  const low = cmd.toLowerCase()

  // Pure workspace inspection and file housekeeping never flicker the active visual stage.
  if (/^(?:cd\s+[^\n&;]+&&\s*)?(?:ls|find|tree|pwd|du|stat|file|wc|head|tail|cat|sed|awk|rg|grep|shasum|mkdir|cp|mv|rm|touch|ln)\b/.test(low)
    && !/cat\s*>|tee\s+/.test(low)) {
    return null
  }

  const runsCad = /(?:^|[;&|]\s*|["'])(?:[^\s"']*(?:cad-python|dev-cad\/bin\/python|tools\/cad\/bin\/python|blender)|"\$(?:cad|py|bl)"|\$(?:cad|py|bl))\b/i.test(cmd)
    || /--background[\s\S]*--python/i.test(cmd)

  if (runsCad) {
    const scriptMatch = cmd.match(/--python\s+["']?([^\s"']+)/)
      ?? cmd.match(/(?:cad-python|python3?|blender)\s+(?:-[^\s]+\s+)*["']?([^\s"']+\.py)\b/i)
    const scriptName = scriptMatch ? basenameOf(scriptMatch[1].toLowerCase()) : ''
    if (/render|view|preview|snap|angle|ortho|sheet|photo|camera/.test(scriptName)
      || /bpy\.ops\.render\.render/.test(low)) return 'look'
    if (/region|label|audit|surface|segment/.test(scriptName)
      || (/regions\.json/.test(low) && !/\.publish\b/.test(low))) return 'regions'
    if (/collision|clearance|intersect|overlap|gap|bvh/.test(scriptName)
      || (/bvhtree|brepextrema/.test(low) && /overlap|dist/.test(low) && !/save_as_mainfile|\.publish\b/.test(low))) return 'collision'
    if (/validate|fdm|print3d|overhang|wall|manifold/.test(scriptName)
      && !/build|make|gen|edit|fix|update/.test(scriptName)) return 'fdm'
    if (/mech|joint_test|hinge_test|wheel_test|sweep|kinemat|motion/.test(scriptName)) return 'mechanics'
    if (/field|control|deform|shape/.test(scriptName)) return 'controls'
    if (/--python-expr|-c\s|<<\s*['"]?(?:py|eof)/i.test(cmd)) {
      if (/render\.render|filepath.*\.png/.test(low)) return 'look'
      if (/bvhtree|brepextrema|overlap|clearance|collision|intersect/.test(low) && !/save_as_mainfile|\.publish\b/.test(low)) return 'collision'
      if (/overhang|wall_thick|manifold|validate\.py|print3d/.test(low) && !/save_as_mainfile|\.publish\b/.test(low)) return 'fdm'
      if (/regions\.json|region_map/.test(low) && !/save_as_mainfile|\.publish\b/.test(low)) return 'regions'
    }
    return 'sculpt'
  }

  if (/bullet/.test(low)) return 'mechanics'
  if (/^\s*(?:cd\s+[^\n&;]+&&\s*)?(?:cat\s*>|tee\s+)/i.test(cmd)) {
    if (/render|view|preview|snap|camera/.test(low)) return 'look'
    if (/region/.test(low)) return 'regions'
    if (/collision|clearance|bvh|overlap/.test(low)) return 'collision'
    if (/validate|fdm|overhang|manifold/.test(low)) return 'fdm'
    if (/\.py/.test(low)) return 'sculpt'
    return null
  }
  if (/(?:^|[;&|]\s*)python3?\b/.test(low)) {
    if (/regions\.json|face_?range|surface_?id/.test(low)) return 'regions'
    if (/collision|clearance|intersect|overlap/.test(low) && !/write_text|\.replace\(/.test(low)) return 'collision'
    if (/overhang|manifold|validate\.py|print3d|fdm/.test(low) && !/write_text|\.replace\(/.test(low)) return 'fdm'
    if (/pillow|pil|montage|concat|contact.?sheet/.test(low)) return 'look'
    if (/build123d|rumi_cad|rumi_joints/.test(low)) return 'sculpt'
    if (/\.py['"]/.test(low) && /(?:write_text|open\(.*['"]w['"]|\.replace\()/.test(low)) return 'sculpt'
  }
  return null
}

/** Default ordered rule chain; callers can extend or replace rules independently. */
export const DEFAULT_CLASSIFIER_RULES = Object.freeze([
  classifyDedicatedTool,
  classifyImageInspection,
  classifyFileEdit,
  classifyShellCommand,
])

/**
 * Run a composable rule chain on one tool call without mutating state.
 * @param {string} name Tool name.
 * @param {unknown} rawArgs Parsed object or raw JSON argument string.
 * @param {readonly Function[]} [rules] Ordered classifier rules.
 * @returns {string | null} Semantic viewer visual stage, or null when absorbed.
 */
export function classifyToolCall(name, rawArgs, rules = DEFAULT_CLASSIFIER_RULES) {
  if (typeof name !== 'string' || !name) return null
  const call = { name, args: parseArgs(rawArgs) }
  for (const rule of rules) {
    const stage = rule(call)
    if (typeof stage === 'string' && VALID_STAGES.has(stage)) return stage
  }
  return null
}

/**
 * Passively track each session's current visual activity stage with anti-flicker dwell.
 *
 * @param {object} ctx Host Cordis context emitting session/event and agent lifecycle events.
 * @param {object} options Tracker dependencies and smoothing parameters.
 * @param {(sessionId: string) => void} options.notify Called when a session's published visual stage changes.
 * @param {readonly Function[]} [options.rules] Custom composable classifier rules.
 * @param {number} [options.minDwellMs] Minimum dwell before replacing one specific visual stage with another.
 * @param {() => number} [options.now] Clock source for deterministic tests.
 * @param {typeof setTimeout} [options.setTimer] Timer scheduler for deterministic tests.
 * @param {typeof clearTimeout} [options.clearTimer] Timer canceller for deterministic tests.
 * @returns {{ read: (sessionId: string) => string | null, clear: (sessionId: string) => void }}
 */
export function createActivityTracker(ctx, {
  notify,
  rules = DEFAULT_CLASSIFIER_RULES,
  minDwellMs = 900,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const states = new Map()
  const runningBySession = new Map()

  function cancelPending(entry) {
    if (entry.timer !== null) {
      clearTimer(entry.timer)
      entry.timer = null
    }
    entry.pending = null
  }

  function clear(sessionId) {
    const entry = states.get(sessionId)
    if (!entry) return
    cancelPending(entry)
    const hadStage = entry.stage !== null
    states.delete(sessionId)
    if (hadStage) notify(sessionId)
  }

  function commit(sessionId, entry, nextStage) {
    cancelPending(entry)
    if (entry.stage === nextStage) return
    entry.stage = nextStage
    entry.changedAt = now()
    notify(sessionId)
  }

  function observeStage(sessionId, stage) {
    if (!stage) return
    let entry = states.get(sessionId)
    if (!entry) {
      entry = { stage: null, changedAt: -Infinity, pending: null, timer: null }
      states.set(sessionId, entry)
    }
    if (entry.stage === stage && entry.pending === null) return
    const elapsed = now() - entry.changedAt
    if (entry.stage === null || minDwellMs <= 0 || elapsed >= minDwellMs) {
      commit(sessionId, entry, stage)
      return
    }
    entry.pending = stage
    if (entry.timer !== null) return
    const wait = Math.max(0, minDwellMs - elapsed)
    entry.timer = setTimer(() => {
      entry.timer = null
      const pending = entry.pending
      entry.pending = null
      if (pending && states.get(sessionId) === entry) commit(sessionId, entry, pending)
    }, wait)
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId || !event) return
    if (event.type === 'turn/end') {
      clear(sessionId)
      return
    }
    if (event.type === 'tool/call') {
      const stage = classifyToolCall(event.data?.name, event.data?.arguments, rules)
      if (stage) observeStage(sessionId, stage)
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    let set = runningBySession.get(sessionId)
    if (status === 'running') {
      if (!set) { set = new Set(); runningBySession.set(sessionId, set) }
      set.add(agent)
    } else if (set) {
      set.delete(agent)
      if (set.size === 0) {
        runningBySession.delete(sessionId)
        clear(sessionId)
      }
    } else if (status === 'idle') {
      clear(sessionId)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    const set = runningBySession.get(sessionId)
    if (set) {
      set.delete(agent)
      if (set.size === 0) {
        runningBySession.delete(sessionId)
        clear(sessionId)
      }
    }
  })

  ctx.on('session/disposed', session => {
    const sessionId = session?.id
    if (!sessionId) return
    runningBySession.delete(sessionId)
    clear(sessionId)
  })

  ctx.effect(() => () => {
    for (const entry of states.values()) cancelPending(entry)
    states.clear()
    runningBySession.clear()
  }, 'print viewer: activity tracker lifetime')

  return {
    /** Current classified visual stage for one conversation, or null to use the generic fallback. */
    read(sessionId) { return states.get(sessionId)?.stage ?? null },
    /** Clear any active visual stage and pending transition for one conversation. */
    clear,
  }
}
