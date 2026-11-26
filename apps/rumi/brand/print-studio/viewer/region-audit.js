/** Check saved region maps for one project's canonical USD entries. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { owningProject, projectById } from '../print-project.js'
import { discoverModels } from './catalog.js'
import { MAX_REGION_MAP_BYTES, readModelRegions } from './model-regions.js'
import { loadInventory } from './surface-worker.js'
import { USD_MAX_BYTES } from './usd.js'

const identity = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
const sameContents = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
const infoAt = path => lstat(path, { bigint: true })

async function readChecked(path, expected, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || identity(info) !== identity(expected) || info.size > limit) throw new Error('Model files changed or exceeded the size limit')
    const bytes = await file.readFile()
    if (identity(await file.stat({ bigint: true })) !== identity(info)) throw new Error('Model files changed during inspection')
    return bytes
  } finally { await file.close() }
}

async function removeInvalid(model, map, modelInfo, mapInfo) {
  const directory = dirname(map)
  if (await realpath(directory) !== directory || identity(await infoAt(model)) !== identity(modelInfo)
    || identity(await infoAt(map)) !== identity(mapInfo)) throw new Error('Model files changed before region cleanup')
  // Claim the directory entry, then verify what was moved before discarding it.
  const claimed = join(directory, `.rumi-region-check-${randomUUID()}`)
  await rename(map, claimed)
  try {
    if (!sameContents(await infoAt(claimed), mapInfo) || identity(await infoAt(model)) !== identity(modelInfo)) {
      throw new Error('Model files changed during region cleanup')
    }
  } catch (error) {
    // A replacement already at the original path takes precedence over the claimed file.
    await link(claimed, map).catch(restoreError => { if (restoreError.code !== 'EEXIST') throw restoreError })
    await unlink(claimed)
    throw error
  }
  await unlink(claimed)
}

async function checkModel(root, path, cache, signal) {
  const model = join(root, path), map = model.replace(/\.usda?$/iu, '.regions.json')
  if (await realpath(dirname(model)) !== dirname(model)) throw new Error('Model directory changed')
  const modelInfo = await infoAt(model)
  if (!modelInfo.isFile()) throw new Error('Expected a regular USD file')
  let mapInfo
  try { mapInfo = await infoAt(map) }
  catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error }
  if (!mapInfo.isFile()) throw new Error('Expected a regular region map')
  const key = identity(modelInfo) + '/' + identity(mapInfo)
  if (cache.get(path) === key) return 'ready'
  let valid = false
  if (mapInfo.size <= MAX_REGION_MAP_BYTES) {
    const bytes = await readChecked(model, modelInfo, USD_MAX_BYTES)
    const raw = await readChecked(map, mapInfo, MAX_REGION_MAP_BYTES)
    const hash = createHash('sha256').update(bytes).digest('hex')
    let parsed
    try { parsed = readModelRegions(JSON.parse(raw.toString('utf8')), hash) }
    catch (_invalidMetadata) { parsed = null }
    if (parsed) {
      const surfaces = parsed.regions.filter(region => region.location.kind === 'surface')
      valid = !surfaces.length || !(await loadInventory(bytes, surfaces, signal, true)).unresolved
    }
  }
  signal.throwIfAborted()
  if (valid) { cache.set(path, key); return 'ready' }
  await removeInvalid(model, map, modelInfo, mapInfo)
  return 'missing'
}

/** Cache successful checks for unchanged files and coalesce concurrent checks.
 * @param {string} root Canonical print project directory.
 * @param {AbortSignal} signal Plugin lifetime.
 * @returns {Function} Refresh the project and return missing maps and inspection failures by model path.
 */
export function createRegionAudit(root, signal) {
  const cache = new Map()
  let pending
  async function scan() {
    const missingRegionMaps = [], regionCheckErrors = []
    const models = (await discoverModels(root)).filter(model => /\.usda?$/iu.test(model.path))
    const current = new Set(models.map(model => model.path))
    for (const path of cache.keys()) if (!current.has(path)) cache.delete(path)
    for (const { path } of models) {
      signal.throwIfAborted()
      try {
        if (await checkModel(root, path, cache, signal) === 'missing') missingRegionMaps.push(path)
      } catch (error) {
        signal.throwIfAborted()
        regionCheckErrors.push({ path, message: error.message })
      }
    }
    return { missingRegionMaps, regionCheckErrors }
  }
  return () => pending ??= scan().finally(() => { pending = undefined })
}

/** Register startup, project-open and agent-request checks for Print Studio.
 * @param {object} ctx Host with project scope and prompt registrations.
 * @returns {Function} Schedule a check when a print project opens.
 */
export function registerRegionAudits(ctx) {
  const scope = ctx.rumiProjectScope
  const lifetime = new AbortController()
  const projects = new Map(), sessions = new WeakMap(), jobs = new Set()
  function refresh(project) {
    let entry = projects.get(project.path)
    if (!entry) {
      entry = { check: createRegionAudit(project.path, lifetime.signal) }
      projects.set(project.path, entry)
    }
    if (!entry.job) {
      const job = entry.check().then(result => { entry.result = result }, error => {
        if (!lifetime.signal.aborted) entry.result = { regionCheckErrors: [{ message: error.message }] }
      }).finally(() => { entry.job = null; jobs.delete(job) })
      entry.job = job
      jobs.add(job)
    }
    return entry.job
  }

  async function startup() {
    let entries
    try { entries = await readdir(scope.workspaceRoot, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const directory of entries) {
      if (lifetime.signal.aborted) return
      if (!directory.isDirectory()) continue
      try {
        const project = projectById(scope.workspaceRoot, directory.name)
        if (project) await refresh(project)
      } catch (error) { ctx.logger.warn('Could not inspect a print project for named regions', error) }
    }
  }
  ctx.effect(() => {
    const started = startup().catch(error => ctx.logger.warn('Could not inspect print projects at startup', error))
    return async () => {
      lifetime.abort()
      await started
      await Promise.allSettled(jobs)
    }
  }, 'print studio: named region checks')
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
      name: 'rumi:named-region-repair', required: true, interpolate: false,
      order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'),
      text: ({ agent }) => {
        const result = projects.get(sessions.get(agent?.session))?.result
        if (!result?.missingRegionMaps?.length && !result?.regionCheckErrors?.length) return ''
        return JSON.stringify(result)
      },
    }), 'print studio: named region repair context')
  })
  return project => { void refresh(project) }
}
