/** Bind badge evidence to a saved model and inspect its data without running project code. */
import { createHash } from 'node:crypto'
import { constants, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PRINT_BADGE_KINDS } from './kinds.js'
import {
  extractMessageText,
  missing,
  MODEL_RECEIPT_PATTERN,
  NON_ZERO_BASH,
  parseJsonBounded,
  PRIVATE_LINE,
  REVISION_PATTERN,
} from './evidence-common.js'
import { validateUsd, USD_MAX_BYTES } from '../viewer/usd.js'
import { parseUsdData } from '../viewer/viewport/usd-parser.js'

const modelPathPattern = /^models\/[^./\\\x00-\x1f][^/\\\x00-\x1f]{0,127}\/model\.usda$/u
const revisionPattern = REVISION_PATTERN
const maxModels = 128
const maxScriptBytes = 128 * 1024
const maxResultChars = 256 * 1024
const maxPartCount = 128
const geometryLine = /\b(barrel_hinge|living_hinge|captive_axle|through_axle|axle_clip|wheel|dovetail_slide|gear_pair|rack_pinion|spur_gear|knuckle|barrel|bore|web_thickness|fold(?:ing|s|ed)?|flexure|dovetail|pinion|rack|teeth|tooth|axle|hinge|clearance|pitch|poly_prism|polygon|cylinder|joint|revolute|prismatic|boolean|bisect|extrude|profile|subtract)\b/iu
const privateLine = PRIVATE_LINE

const statKey = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const portablePath = (projectRoot, path) => isAbsolute(path) ? relative(projectRoot, path) : path
const name = path => path.split('/').at(-1)

/**
 * Capture filesystem identities at a turn boundary without opening model bytes.
 * @param {string} projectRoot Canonical registered project directory.
 * @returns {{modelPath: string, statKey: string}[]} Canonical saved USD entries, excluding links.
 */
export function capturePrintBadgeRevisions(projectRoot) {
  const directory = join(projectRoot, 'models')
  try {
    if (realpathSync(directory) !== directory) return []
    const entries = readdirSync(directory, { withFileTypes: true })
    if (entries.length > maxModels) return []
    const snapshots = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const modelPath = `models/${entry.name}/model.usda`
      if (!modelPathPattern.test(modelPath)) continue
      const absolute = join(projectRoot, modelPath)
      try {
        const info = lstatSync(absolute, { bigint: true })
        if (info.isFile() && info.nlink === 1n && realpathSync(dirname(absolute)) === dirname(absolute)) {
          snapshots.push({ modelPath, statKey: statKey(info) })
        }
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    return snapshots.sort((left, right) => left.modelPath.localeCompare(right.modelPath))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

async function readBounded(path, maxBytes, signal, expected) {
  signal.throwIfAborted()
  const parent = dirname(path)
  try {
    if (await realpath(parent) !== parent) return null
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat({ bigint: true })
      const key = statKey(info)
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(maxBytes)
        || (expected !== undefined && key !== expected) || await realpath(parent) !== parent
        || statKey(await lstat(path, { bigint: true })) !== key) return null
      const size = Number(info.size)
      const bytes = Buffer.allocUnsafe(size)
      let offset = 0
      while (offset < size) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
        if (!bytesRead) return null
        offset += bytesRead
      }
      if (statKey(await handle.stat({ bigint: true })) !== key || await realpath(parent) !== parent
        || statKey(await lstat(path, { bigint: true })) !== key) return null
      return bytes
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

const json = text => parseJsonBounded(text, maxResultChars)
const messageText = extractMessageText

function acceptedCommands(events) {
  const calls = new Map(), commands = []
  for (const { type, data, seq } of events) {
    if (type === 'tool/call' && ['bash', 'validation_mechanics'].includes(data.name)) calls.set(data.callId, data)
    const message = type === 'tool/ptc-dispatch' ? data : type === 'tool/result' ? data.message : undefined
    if (!message) continue
    const call = type === 'tool/ptc-dispatch' ? data : calls.get(message.toolCallId)
    if (!call || message.isError || !['bash', 'validation_mechanics'].includes(call.name)) continue
    const output = messageText(message, maxResultChars)
    if (NON_ZERO_BASH.test(output)
      || output.startsWith('started background job ')) continue
    const args = type === 'tool/ptc-dispatch' ? call.arguments : json(call.arguments)
    if (call.name === 'bash') {
      const reports = [...output.matchAll(MODEL_RECEIPT_PATTERN)].slice(-16)
        .flatMap(match => {
          const receipt = json(match[1])
          return typeof receipt?.preview === 'string' && typeof receipt?.revisionUsd === 'string'
            ? [{
                preview: receipt.preview.slice(0, 4096), revisionUsd: receipt.revisionUsd.slice(0, 4096),
                savedFileStat: typeof receipt.savedFileStat === 'string' && receipt.savedFileStat.length <= 128
                  ? receipt.savedFileStat : undefined,
                sourceHash: typeof receipt.sourceHash === 'string' && /^[a-f\d]{64}$/u.test(receipt.sourceHash)
                  ? receipt.sourceHash : undefined,
              }] : []
        })
      if (!reports.length) continue
      const match = typeof args?.command === 'string'
        && /(?:^|\s)--python\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))/u.exec(args.command.slice(0, maxResultChars))
      const script = match ? match.slice(1).find(Boolean)?.slice(0, 4096) : undefined
      commands.push({ seq, reports, script })
    } else {
      const result = json(output)
      const report = result?.report
      if (result?.status !== 'passed' || report?.assemblyVerified !== true || report.coverage?.complete !== true
        || typeof result.path !== 'string' || typeof result.fingerprint !== 'string') continue
      const scoped = (report.connections ?? []).slice(0, maxPartCount).filter(connection => report.coverage.connections?.includes(connection.id)
        && connection.probeCounts?.passed > 0
        && connection.probeCounts.needs_repair === 0 && connection.probeCounts.review === 0)
        .map(({ id }) => id).filter(id => typeof id === 'string' && id.length <= 128)
      if (scoped.length) commands.push({ seq, validation: { path: result.path.slice(0, 4096),
        sourceHash: result.sourceHash, fingerprint: result.fingerprint, joints: scoped } })
    }
    if (commands.length > 32) commands.shift()
  }
  return commands
}

function publishedRevisions(projectRoot, modelPath, commands) {
  const reports = []
  for (const command of commands) {
    for (const report of command.reports ?? []) {
      if (portablePath(projectRoot, report.preview) !== modelPath) continue
      const revisionFile = portablePath(projectRoot, report.revisionUsd)
      const revision = name(dirname(revisionFile))
      if (revisionPattern.test(revision) && revisionFile === join(dirname(modelPath), 'revisions', revision, 'model.usda')) {
        const canonical = report.preview === join(projectRoot, modelPath)
          && report.revisionUsd === join(projectRoot, revisionFile)
        reports.push({ revision, seq: command.seq, script: command.script,
          ...(canonical && report.savedFileStat && report.sourceHash
            ? { savedFileStat: report.savedFileStat, sourceHash: report.sourceHash, path: report.revisionUsd } : {}) })
      }
    }
  }
  return reports.reverse()
}

async function matchingRevision(projectRoot, modelPath, source, reports, signal) {
  const directory = join(projectRoot, dirname(modelPath), 'revisions')
  try {
    if (await realpath(directory) !== directory) return undefined
    const entries = await readdir(directory, { withFileTypes: true })
    const recent = await Promise.all(entries.filter(item => item.isDirectory() && revisionPattern.test(item.name))
      .slice(0, 128).map(async item => {
        try { return { revision: item.name, time: (await lstat(join(directory, item.name))).mtimeMs } }
        catch (error) { if (missing(error)) return null; throw error }
      }))
    const keys = new Set([...reports.slice(0, 16).map(report => report.revision),
      ...recent.filter(Boolean).sort((left, right) => right.time - left.time).slice(0, 8).map(item => item.revision)])
    for (const revision of keys) {
      const bytes = await readBounded(join(directory, revision, 'model.usda'), source.length, signal)
      if (bytes?.equals(source)) return revision
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  return undefined
}

function excerpts(text, limit) {
  const selected = []
  for (const raw of text.split('\n')) {
    if (privateLine.test(raw)) continue
    const line = raw.trim()
    if (!line || line.startsWith('#') || !geometryLine.test(line)) continue
    const masked = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gu, '""').split('#', 1)[0].trim()
    if (masked.length > 200 || !masked || !geometryLine.test(masked)) continue
    selected.push(masked)
    if (selected.length === limit) break
  }
  return selected
}

async function construction(projectRoot, modelPath, publication, signal) {
  const path = publication?.script
  if (!path) return undefined
  const relativePath = portablePath(projectRoot, path)
  const allowed = relativePath.startsWith('source/') || relativePath.startsWith(`${dirname(modelPath)}/`)
  if (!allowed || !/^(?:[a-z\d_. -]+\/)*[a-z\d_. -]+\.py$/iu.test(relativePath)
    || relativePath.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) return undefined
  const bytes = await readBounded(join(projectRoot, relativePath), maxScriptBytes, signal)
  if (!bytes) return undefined
  const lines = excerpts(bytes.toString('utf8'), 22)
  if (!lines.length) return undefined
  return { ref: `construction:${publication.seq}`, lines }
}

const number = value => Math.round(value * 1000) / 1000
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const property = (specs, path, key) => specs[`${path}.${key}`]?.fields.default
function extentOf(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length % 3 !== 0) return undefined
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < points.length; index++) {
    const value = points[index]
    if (!Number.isFinite(value)) return undefined
    const axis = index % 3
    low[axis] = Math.min(low[axis], value)
    high[axis] = Math.max(high[axis], value)
  }
  return [low, high]
}
const relationships = (specs, path, key) => (specs[`${path}.${key}`]?.fields.targetPaths ?? [])
  .flatMap(value => value.startsWith('[') ? value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean) : [value])

function summarizeGeometry(bytes) {
  const specs = parseUsdData(validateUsd(bytes)).specsByPath
  const layer = specs['/']?.fields
  if (layer?.upAxis !== 'Z' || layer.metersPerUnit !== 1) return undefined
  const meshEntries = Object.entries(specs).filter(([, spec]) => spec.specType === 6 && spec.fields.typeName === 'Mesh')
  if (!meshEntries.length || meshEntries.length > maxPartCount) return undefined
  const parts = meshEntries.map(([path], index) => {
    const points = property(specs, path, 'points')
    const extent = extentOf(points)
    const translation = property(specs, path, 'xformOp:translate')
    return {
      ref: `part:${index}`, name: name(path).slice(0, 80),
      ...(extent
        ? { vertices: points.length / 3, sizeMm: extent[0].map((lower, axis) => number((extent[1][axis] - lower) * 1000)) } : {}),
      ...(vector(translation) ? { localOffsetMm: translation.map(value => number(value * 1000)) } : {}),
      path, extent,
    }
  })
  const partIds = new Map(parts.map(part => [part.path, part.ref]))
  const joints = []
  for (const [path, spec] of Object.entries(specs)) {
    const kind = { PhysicsRevoluteJoint: 'revolute', PhysicsPrismaticJoint: 'prismatic', PhysicsFixedJoint: 'fixed' }[spec.fields.typeName]
    if (spec.specType !== 6 || !kind || joints.length >= maxPartCount) continue
    const parent = partIds.get(relationships(specs, path, 'physics:body0')[0])
    const child = partIds.get(relationships(specs, path, 'physics:body1')[0])
    if (!parent || !child) continue
    const axis = property(specs, path, 'physics:axis')
    const lower = property(specs, path, 'physics:lowerLimit'), upper = property(specs, path, 'physics:upperLimit')
    const scale = kind === 'prismatic' ? 1000 : 1
    joints.push({ ref: `joint:${joints.length}`, id: name(path).slice(0, 80), kind, parent, child,
      ...(['X', 'Y', 'Z'].includes(axis) ? { axis } : {}),
      ...(Number.isFinite(lower) && Number.isFinite(upper) ? { range: [number(lower * scale), number(upper * scale)] } : {}) })
  }
  const root = `/${layer.defaultPrim}`
  const steps = json(property(specs, root, 'rumi:disassembly'))
  const removal = new Map()
  if (Array.isArray(steps) && steps.length <= maxPartCount) {
    for (const step of steps) {
      const offsets = step?.path
      if (!Array.isArray(offsets) || offsets.length < 2 || offsets.length > 64 || !offsets.every(vector)
        || offsets[0].some(value => value !== 0)) continue
      const end = offsets.at(-1)
      const axis = end.findIndex(value => value !== 0)
      if (axis < 0 || offsets.some(offset => offset.some((value, index) => index !== axis && value !== 0))) continue
      removal.set(step.part, { axis: 'xyz'[axis], travelMm: end[axis] })
    }
  }
  return { parts, joints, specs, removal }
}

function conversation(events) {
  const snippets = []
  for (const event of events) {
    const { type, data, seq } = event
    const message = type === 'assistant/message' ? data.message
      : type === 'user/message' && data.source?.kind === 'user' ? data : undefined
    if (!message) continue
    const lines = messageText(message, 1400).split('\n').filter(line => geometryLine.test(line) && !privateLine.test(line))
    if (lines.length) snippets.push({ ref: `conversation:${seq}`, role: message.role, text: lines.join('\n').slice(0, 420) })
  }
  return snippets.slice(-8)
}

function validationIdentities(events) {
  const identities = new Map()
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'runtime-context') continue
    const raw = event.data.source.sections?.find(section => section.name === 'rumi:mesh-state')?.text
    const state = json(raw)
    for (const entry of (state?.meshState?.validation?.models ?? []).slice(0, maxPartCount)) {
      if (typeof entry.path === 'string' && entry.path.length <= 4096
        && /^[a-f\d]{64}$/u.test(entry.sourceHash) && /^[a-f\d]{64}$/u.test(entry.fingerprint)) {
        identities.set(entry.fingerprint, { path: entry.path, sourceHash: entry.sourceHash, fingerprint: entry.fingerprint })
      }
    }
  }
  return [...identities.values()].slice(-maxPartCount)
}

function mechanics(commands, identities, sourceHash, modelPath, joints) {
  const exactFingerprints = new Set(identities.filter(item => item.path === modelPath && item.sourceHash === sourceHash)
    .map(item => item.fingerprint))
  for (const command of [...commands].reverse()) {
    const result = command.validation
    if (result?.path !== modelPath
      || (result.sourceHash === undefined ? !exactFingerprints.has(result.fingerprint) : result.sourceHash !== sourceHash)) continue
    const checkedJoints = joints.filter(joint => joint.kind !== 'fixed' && result.joints.includes(joint.id)).map(joint => joint.ref)
    if (checkedJoints.length) return { ref: `movement-check:${command.seq}`, checkedJoints }
  }
  return undefined
}

/**
 * Filter one completed turn to bounded, serializable badge evidence.
 * @param {object[]} events Immutable events through the completed turn.
 * @returns {object} Build and validation receipts and short design-context excerpts.
 */
export function badgeTurnEvidence(events) {
  return { commands: acceptedCommands(events), validation: validationIdentities(events), conversation: conversation(events) }
}

async function recipeFacts(projectRoot, modelPath, revision, geometry, signal) {
  if (!revisionPattern.test(revision)) return []
  const path = join(projectRoot, dirname(modelPath), 'revisions', revision, 'report.json')
  const bytes = await readBounded(path, 32 * 1024, signal)
  const report = bytes ? json(bytes.toString('utf8')) : undefined
  if (!Array.isArray(report?.badgeFeatures)) return []
  const recipes = []
  for (const feature of report.badgeFeatures.slice(0, maxPartCount)) {
    if (!PRINT_BADGE_KINDS.includes(feature?.kind) || !Array.isArray(feature.parts)) continue
    const parts = feature.parts.map(name => geometry.parts.find(part => part.name === name)?.ref)
    const joints = Array.isArray(feature.joints) ? feature.joints.map(id => geometry.joints.find(joint => joint.id === id)?.ref) : []
    if (!parts.length || parts.includes(undefined) || joints.includes(undefined)) continue
    recipes.push({ ref: `recipe:${recipes.length}`, kind: feature.kind, parts, joints })
    if (recipes.length === 24) break
  }
  return recipes
}

/**
 * Read one exact saved revision and produce compact facts for the evaluator.
 * A superseded preview remains reviewable when its publication receipt binds the turn's file identity to matching archived bytes.
 * @param {string} projectRoot Canonical registered project directory.
 * @param {{modelPath: string, statKey: string}} target Snapshot of the saved model at the turn boundary.
 * @param {object[]|object} events Immutable events or filtered turn evidence through completion.
 * @param {AbortSignal} signal Cancels bounded reads.
 * @returns {Promise<object|undefined>} Snapshot and read-only inspection data, or no eligible revision.
 */
export async function readPrintBadgeEvidence(projectRoot, target, events, signal) {
  const { modelPath } = target
  if (!modelPathPattern.test(modelPath)) return undefined
  const turn = Array.isArray(events) ? badgeTurnEvidence(events) : events
  const { commands } = turn
  const publications = publishedRevisions(projectRoot, modelPath, commands)
  const receipt = publications.find(report => report.savedFileStat === target.statKey && report.path)
  const archived = receipt && await readBounded(receipt.path, USD_MAX_BYTES, signal)
  const archivedHash = archived && createHash('sha256').update(archived).digest('hex')
  const pinned = Boolean(archivedHash && archivedHash === receipt.sourceHash)
  const source = pinned ? archived : await readBounded(resolve(projectRoot, modelPath), USD_MAX_BYTES, signal, target.statKey)
  if (!source) return undefined
  const sourceHash = pinned ? archivedHash : createHash('sha256').update(source).digest('hex')
  const revision = pinned ? receipt.revision
    : await matchingRevision(projectRoot, modelPath, source, publications, signal) ?? sourceHash
  const publication = pinned ? receipt : publications.find(report => report.revision === revision)
  const geometry = summarizeGeometry(source)
  if (!geometry) return undefined
  const script = isCurrentPrintBadgeRevision(projectRoot, target)
    ? await construction(projectRoot, modelPath, publication, signal)
    : undefined
  const recipes = await recipeFacts(projectRoot, modelPath, revision, geometry, signal)
  const checkedMotion = mechanics(commands, turn.validation, sourceHash, modelPath, geometry.joints)
  const matingSections = recipes.some(recipe => recipe.kind === 'dovetail-slide') ? [] : inspectRemovableMatingParts(geometry)
  return {
    revision, sourceHash, pinned, geometry,
    facts: {
      parts: geometry.parts.map(({ path: _path, extent: _extent, ...part }) => part), joints: geometry.joints,
      recipes, construction: script, conversation: turn.conversation, checkedMotion,
      ...(matingSections.length ? { matingSections } : {}),
    },
  }
}

/**
 * Confirm that an inspected revision is still current before recording an award.
 * @param {string} projectRoot Canonical registered project directory.
 * @param {{modelPath: string, statKey: string}} target Original saved-file identity.
 * @returns {boolean} Whether the same regular saved file remains current.
 */
export function isCurrentPrintBadgeRevision(projectRoot, target) {
  if (!modelPathPattern.test(target.modelPath)) return false
  const path = join(projectRoot, target.modelPath)
  try {
    const info = lstatSync(path, { bigint: true })
    return info.isFile() && info.nlink === 1n && realpathSync(dirname(path)) === dirname(path) && statKey(info) === target.statKey
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

function clipLine(start, end, low, high) {
  let first = 0, last = 1
  for (const index of [0, 1]) {
    const delta = end[index] - start[index]
    if (delta === 0) {
      if (start[index] < low[index] || start[index] > high[index]) return null
      continue
    }
    const entry = (low[index] - start[index]) / delta
    const exit = (high[index] - start[index]) / delta
    first = Math.max(first, Math.min(entry, exit))
    last = Math.min(last, Math.max(entry, exit))
    if (first > last) return null
  }
  return [first, last].map(fraction => start.map((value, index) => value + fraction * (end[index] - value)))
}

/** A bounded contour display contains actual cross-sections and no project instructions. */
function section(points, triangles, axis, fraction, extent, cropped = false) {
  const width = cropped ? 36 : 24
  const grid = Array.from({ length: width }, () => Array(width).fill('.'))
  const slopes = new Set()
  const [horizontal, vertical] = [0, 1, 2].filter(index => index !== axis)
  const spans = extent[0].map((minimum, index) => extent[1][index] - minimum)
  if (spans.some(span => !(span > 0))) return { rows: [], verticalSpansMm: [] }
  const plane = extent[0][axis] + fraction * spans[axis]
  const pixel = (value, index) => Math.max(0, Math.min(width - 1, Math.round((value - extent[0][index]) / spans[index] * (width - 1))))
  const samples = [.125, .25, .375, .5, .625, .75, .875].map(at => ({
    at, horizontal: extent[0][horizontal] + at * spans[horizontal], minimum: Infinity, maximum: -Infinity,
  }))
  for (let index = 0; index + 2 < triangles.length; index += 3) {
    const vertices = [0, 1, 2].map(offset => {
      const coordinate = 3 * triangles[index + offset]
      return [points[coordinate], points[coordinate + 1], points[coordinate + 2]]
    })
    if (!vertices.every(vector)) continue
    const intersections = []
    for (let edge = 0; edge < 3; edge++) {
      const a = vertices[edge], b = vertices[(edge + 1) % 3]
      if ((a[axis] <= plane) === (b[axis] <= plane)) continue
      const t = (plane - a[axis]) / (b[axis] - a[axis])
      intersections.push([a[horizontal] + t * (b[horizontal] - a[horizontal]),
        a[vertical] + t * (b[vertical] - a[vertical])])
    }
    if (intersections.length !== 2) continue
    const line = cropped ? clipLine(intersections[0], intersections[1], [extent[0][horizontal], extent[0][vertical]],
      [extent[1][horizontal], extent[1][vertical]]) : intersections
    if (!line) continue
    const [[startHorizontal, startVertical], [endHorizontal, endVertical]] = line
    const delta = endHorizontal - startHorizontal
    const rise = endVertical - startVertical
    const gradient = Math.abs(rise / delta)
    if (cropped && gradient >= .15 && gradient <= 6 && Math.hypot(delta, rise) >= .0008) {
      slopes.add(Math.sign(delta * rise))
    }
    if (delta) for (const sample of samples) {
      const t = (sample.horizontal - startHorizontal) / delta
      if (t < 0 || t > 1) continue
      const height = startVertical + t * (endVertical - startVertical)
      sample.minimum = Math.min(sample.minimum, height)
      sample.maximum = Math.max(sample.maximum, height)
    }
    const x = pixel(startHorizontal, horizontal), y = pixel(startVertical, vertical)
    const endX = pixel(endHorizontal, horizontal), endY = pixel(endVertical, vertical)
    const distance = Math.max(Math.abs(endX - x), Math.abs(endY - y), 1)
    for (let step = 0; step <= distance; step++) {
      const column = Math.round(x + (endX - x) * step / distance)
      const row = Math.round(y + (endY - y) * step / distance)
      grid[width - 1 - row][column] = '#'
    }
  }
  return { rows: grid.map(row => row.join('')), ...(cropped ? { opposingFlanks: slopes.size === 2 } : {}),
    verticalSpansMm: samples.map(sample => ({
    at: sample.at, span: Number.isFinite(sample.minimum) ? number(1000 * (sample.maximum - sample.minimum)) : null,
  })) }
}

function hasThinWeb({ verticalSpansMm }) {
  const spans = verticalSpansMm.map(item => item.span)
  const side = Math.min(Math.max(spans[0], spans[1]), Math.max(spans[5], spans[6]))
  return side > 0 && spans.slice(2, 5).some(span => span > 0 && span <= .4 * side)
}

/**
 * Require corroborating thin web measurements at separate cuts.
 * @param {object} section Evidence for an axis of one saved part.
 * @returns {boolean} Whether at least two contours record a thinner central span between thicker sides.
 */
export function showsThinWeb(section) {
  return section.contours.filter(hasThinWeb).length >= 2
}

/**
 * Inspect selected axes of known mesh parts. For a possible fold, sample additional supporting cuts when the standard cuts miss it.
 * @param {object} geometry Geometry from the immutable reviewed revision.
 * @param {{part: string, axis: string, sampleThinWeb?: boolean}[]} requests At most three inspected axes. The initial single-mesh review may enable the extra sampling.
 * @returns {object[]} Local contours, axis and size in millimetres, each with a citeable identifier.
 */
export function inspectPrintBadgeParts(geometry, requests) {
  return requests.flatMap(({ part, axis, sampleThinWeb }) => {
    const entry = geometry.parts.find(item => item.ref === part)
    if (!entry || !['x', 'y', 'z'].includes(axis)) return []
    const inspected = inspectPart(geometry.specs, entry, axis, entry.extent, undefined, sampleThinWeb)
    return inspected ? [inspected] : []
  })
}

function inspectPart(specs, entry, axis, extent, frame, sampleThinWeb = false) {
  const points = property(specs, entry.path, 'points')
  const counts = property(specs, entry.path, 'faceVertexCounts')
  const triangles = property(specs, entry.path, 'faceVertexIndices')
  if (!Array.isArray(points) || !Array.isArray(counts) || !counts.every(count => count === 3)
    || !Array.isArray(triangles) || triangles.length !== 3 * counts.length || counts.length > 200000 || !extent) return null
  const part = entry.ref
  const index = 'xyz'.indexOf(axis)
  const [horizontalAxis, verticalAxis] = [...'xyz'].filter(value => value !== axis)
  const cut = fraction => ({ fraction, ...section(points, triangles, index, fraction, extent, Boolean(frame)) })
  const contours = [.23, .51, .76].map(cut)
  if (sampleThinWeb && verticalAxis === 'z') {
    let supportingCuts = contours.filter(hasThinWeb).length
    for (const fraction of [.36, .64, .11, .89]) {
      if (supportingCuts >= 2) break
      const candidate = cut(fraction)
      if (!hasThinWeb(candidate)) continue
      contours.push(candidate)
      supportingCuts += 1
    }
    contours.sort((left, right) => left.fraction - right.fraction)
  }
  return { ref: frame ? `mating:${part}:${axis}` : `section:${part}:${axis}`, part, axis, horizontalAxis, verticalAxis,
    sizeMm: extent[1].map((upper, i) => number((upper - extent[0][i]) * 1000)),
    ...(frame ? { frame } : {}), contours }
}

function inspectRemovableMatingParts({ specs, parts, joints, removal }) {
  for (const joint of joints) {
    if (joint.kind !== 'fixed' || !/dove[_ -]?tail/iu.test(joint.id)) continue
    const parent = parts.find(part => part.ref === joint.parent)
    const child = parts.find(part => part.ref === joint.child)
    const motion = removal.get(child.name)
    if (!motion || !parent.extent || !child.extent || [parent, child].some(part =>
      !/^\/[^/]+\/[^/]+$/u.test(part.path) || Object.keys(specs).some(path => path.startsWith(`${part.path}.xformOp`)))) continue
    const low = parent.extent[0].map((value, index) => Math.max(value, child.extent[0][index]))
    const high = parent.extent[1].map((value, index) => Math.min(value, child.extent[1][index]))
    if (low.some((value, index) => value >= high[index])) continue
    const direction = 'xyz'.indexOf(motion.axis)
    const cropped = [low.map((value, index) => index === direction ? value : value - .002),
      high.map((value, index) => index === direction ? value : value + .002)]
    const sections = [parent, child].map(part => inspectPart(specs, part, motion.axis, cropped, joint.ref))
    if (sections.every(Boolean) && sections[0].contours.some((contour, index) =>
      contour.opposingFlanks && sections[1].contours[index].opposingFlanks)) {
      return [{ joint: joint.ref, removal: motion, sections }]
    }
  }
  return []
}
