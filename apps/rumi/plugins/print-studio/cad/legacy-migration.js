/**
 * Temporary Blender-to-CAD migration check for older Rumi Print Studio projects.
 *
 * When a legacy Blender-era project is opened or receives an agent request, this module:
 * 1. Atomically refreshes stale Blender instructions in the project's `AGENTS.md` to the
 *    current `build123d` CAD template while preserving the project's header and base sections.
 * 2. Detects any `models/<name>/model.usda` still authored by Blender (no `doc = "Rumi CAD"`)
 *    and injects a temporary `rumi:legacy-cad-upgrade` context block so the agent upgrades
 *    the model to `build123d` CAD first instead of calling removed Blender binaries or
 *    hand-editing `model.usda`.
 *
 * Once a model is republished by `build123d` CAD, the notice clears automatically. Remove
 * this module and its single registration call in `index.js` once legacy projects have moved on.
 */
import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { owningProject } from '../print-project.js'
import { discoverModels } from '../viewer/catalog.js'

const USD_HEADER_BYTES = 2048
const MAX_AGENTS_BYTES = 128 * 1024
const MAX_SCRIPT_BYTES = 512 * 1024
const LEGACY_AGENTS_MARKER = /\b(?:blender_status|blender-modeling)\b/u
const LEGACY_BLENDER_SCRIPT_MARKER = /\b(?:import\s+bpy|from\s+bpy\b|rumi_blender\.py)\b/u
const PRINT_SECTION_HEADING = '### Project type'
const FALLBACK_SECTION_HEADING = '### Editable designs'

async function readHeadUtf8(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) return null
    const size = Math.min(info.size, maxBytes)
    if (size <= 0) return ''
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await file.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

async function hasLegacyBlenderRevisionsOnly(modelDirectory) {
  let entries
  try {
    entries = await readdir(join(modelDirectory, 'revisions'), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw error
  }
  let sawBlend = false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let files
    try {
      files = await readdir(join(modelDirectory, 'revisions', entry.name))
    } catch {
      continue
    }
    if (files.includes('model.step') || files.includes('model.brep')) return false
    if (files.some(name => name.endsWith('.blend'))) sawBlend = true
  }
  return sawBlend
}

/**
 * Check whether one project `models/<name>/model.usda` is still a legacy Blender-exported model.
 * @param {string} root - Canonical project directory.
 * @param {string} relativeModelPath - Project-relative USD path.
 * @returns {Promise<boolean>} True when the model has not yet been republished by Rumi CAD.
 */
async function isLegacyBlenderModel(root, relativeModelPath) {
  const fullPath = join(root, relativeModelPath)
  let header
  try {
    header = await readHeadUtf8(fullPath, USD_HEADER_BYTES)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return false
    throw error
  }
  if (header === null) return false
  if (/doc\s*=\s*"Rumi CAD"/u.test(header)) return false
  if (/doc\s*=\s*"Blender\b/u.test(header) || /\bdictionary\s+Blender\b/u.test(header)) return true
  return hasLegacyBlenderRevisionsOnly(dirname(fullPath))
}

async function findLegacyBlenderScripts(root) {
  const sourceDir = join(root, 'source')
  let entries
  try {
    entries = await readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  const scripts = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.py')) continue
    const fullPath = join(sourceDir, entry.name)
    try {
      const text = await readHeadUtf8(fullPath, MAX_SCRIPT_BYTES)
      if (text !== null && LEGACY_BLENDER_SCRIPT_MARKER.test(text)) {
        scripts.push(`source/${entry.name}`)
      }
    } catch {
      // Ignore unreadable or symlinked source files.
    }
  }
  return scripts
}

/**
 * Atomically replace stale Blender instructions inside a project's `AGENTS.md` with the
 * current Print Studio CAD template, preserving the project title and base sections above it.
 * @param {string} root - Canonical project directory.
 * @param {string} templatePath - Path to Print Studio's current `AGENTS_TEMPLATE.md`.
 * @returns {Promise<boolean>} True when `AGENTS.md` was updated.
 */
export async function upgradeLegacyProjectInstructions(root, templatePath) {
  const canonicalRoot = await realpath(root)
  const agentsPath = join(canonicalRoot, 'AGENTS.md')
  let info
  try {
    info = await lstat(agentsPath)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size > MAX_AGENTS_BYTES) return false

  const existing = await readHeadUtf8(agentsPath, MAX_AGENTS_BYTES)
  if (existing === null || !LEGACY_AGENTS_MARKER.test(existing)) return false

  const template = (await readFile(templatePath, 'utf8')).trim()
  let markerIndex = existing.indexOf(PRINT_SECTION_HEADING)
  let replacement = template
  if (markerIndex === -1) {
    markerIndex = existing.indexOf(FALLBACK_SECTION_HEADING)
    const fallbackStart = template.indexOf(FALLBACK_SECTION_HEADING)
    if (markerIndex === -1 || fallbackStart === -1) return false
    replacement = template.slice(fallbackStart).trim()
  }

  const prefix = existing.slice(0, markerIndex).trimEnd()
  const updated = `${prefix}\n\n${replacement}\n`
  if (updated === existing) return false
  await writeFileAtomic(agentsPath, updated, { mode: 0o600 })
  return true
}

/**
 * Inspect a print project for legacy Blender models and scripts, refreshing stale `AGENTS.md`
 * instructions in place when needed.
 * @param {string} root - Project directory path.
 * @param {string} templatePath - Path to Print Studio's current `AGENTS_TEMPLATE.md`.
 * @returns {Promise<{instructionsUpgraded: boolean, legacyBlenderModels: string[], legacyBlenderScripts: string[]}>}
 */
export async function inspectLegacyBlenderProject(root, templatePath) {
  const instructionsUpgraded = await upgradeLegacyProjectInstructions(root, templatePath)
  const models = (await discoverModels(root)).filter(model => /\.usda?$/iu.test(model.path))
  const legacyBlenderModels = []
  for (const { path } of models) {
    if (await isLegacyBlenderModel(root, path)) legacyBlenderModels.push(path)
  }
  const legacyBlenderScripts = legacyBlenderModels.length > 0 ? await findLegacyBlenderScripts(root) : []
  return { instructionsUpgraded, legacyBlenderModels, legacyBlenderScripts }
}

/**
 * Format the temporary system-prompt context block when a project still has Blender models.
 * Returns an empty string when all models are already on CAD.
 * @param {{legacyBlenderModels: string[], legacyBlenderScripts: string[]}} status - Inspection result.
 * @returns {string} System-prompt context text, or '' when no upgrade is needed.
 */
export function formatLegacyCadUpgradeNotice(status) {
  if (!status?.legacyBlenderModels?.length) return ''
  const payload = JSON.stringify({
    legacyBlenderModels: status.legacyBlenderModels,
    ...(status.legacyBlenderScripts?.length ? { legacyBlenderScripts: status.legacyBlenderScripts } : {}),
  })
  return [
    'Legacy Blender-to-CAD upgrade required (temporary migration notice):',
    payload,
    'Blender is no longer bundled in Rumi. Before applying the user request to any model in legacyBlenderModels:',
    '1. Briefly tell the user in plain words that you are upgrading their older model to Rumi\'s new CAD builder first, then making their change.',
    '2. Do not run Blender and do not hand-edit model.usda directly. Call cad_status and follow cad-modeling (and printable-joints when the model has multiple or moving parts).',
    '3. Read any listed legacyBlenderScripts and inspect the existing model.usda for the target shape, dimensions, part roles, multi-color surfaces, and intended movements/controls. Preserve multi-color details on single solids with K.paint_faces / K.split_faces (or helper["paint_faces"]) instead of flattening a part to one color.',
    '4. Rebuild connectors and moving joints with verified printable-joints recipes rather than copying legacy hand-rolled Blender joint geometry or manual disassembly steps verbatim; pass recipe results directly to K.publish so retainers, clearances, and topologically ordered disassembly actions are generated cleanly.',
    '5. Apply the user\'s requested change in the new build123d script under source/, publish a CAD revision (STEP, B-Rep, and USD) into the same models/<name>/ folder, load it with viewer_load, run validation_mechanics and validation_accept until passing (fixing any geometry, clearance, retention, or disassembly failures), and complete name-model-regions.',
  ].join('\n')
}

/**
 * Register temporary Blender-to-CAD migration checks on project open and before agent steps.
 * @param {object} ctx - Cordis host context with project scope and system prompt services.
 * @param {string} templatePath - Path to Print Studio's current `AGENTS_TEMPLATE.md`.
 * @returns {(project: {path: string}) => void} Trigger for `PRINT_TYPE.onOpen`.
 */
export function registerLegacyCadMigration(ctx, templatePath) {
  const scope = ctx.rumiProjectScope
  const statuses = new Map()
  const sessions = new WeakMap()
  const pending = new Map()
  const jobs = new Set()

  function refresh(project) {
    const existing = pending.get(project.path)
    if (existing) return existing
    const job = inspectLegacyBlenderProject(project.path, templatePath)
      .then(result => {
        statuses.set(project.path, result)
        return result
      }, error => {
        ctx.logger?.warn('Could not check legacy Blender migration state for print project', error)
      })
      .finally(() => {
        if (pending.get(project.path) === job) pending.delete(project.path)
        jobs.delete(job)
      })
    pending.set(project.path, job)
    jobs.add(job)
    return job
  }

  ctx.effect(() => () => Promise.allSettled(jobs), 'print studio: legacy cad migration')

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const project = owningProject(scope, agent.session)
    if (project) {
      sessions.set(agent.session, project.path)
      await refresh(project)
    }
    return next()
  })

  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:legacy-cad-upgrade',
      required: true,
      interpolate: false,
      order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'),
      text: ({ agent }) => formatLegacyCadUpgradeNotice(statuses.get(sessions.get(agent?.session))),
    }), 'print studio: legacy cad upgrade notice')
  })

  return project => { void refresh(project) }
}
