/** Agent discovery of revision-bound part paths, connected surface IDs and viewer-ordered triangles. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { USD_MAX_BYTES } from './usd.js'
import { saveAnalyzedMesh, saveAnalyzedRanges } from './cursor.js'
import { MAX_REGION_MAP_BYTES, readModelRegions } from './model-regions.js'

const pageSize = 24
const inlineRangeLimit = 16
const readable = value => Number(value.toPrecision(6))
const vector = (values, row) => Array.from(values.subarray(row * 3, row * 3 + 3), readable)

async function loadInventory(bytes, regions, signal) {
  signal.throwIfAborted()
  const buffer = Uint8Array.from(bytes).buffer
  const worker = new Worker(new URL('./surface-analysis-worker.js', import.meta.url), {
    workerData: { bytes: buffer, regions }, transferList: [buffer], execArgv: [],
  })
  let cancel
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`Mesh analysis exited before returning its measurements (code ${code})`)))
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    await worker.terminate()
  }
}

function partPage(parts, offset) {
  return { total: parts.length, parts: parts.slice(offset, offset + pageSize).map(part => ({
    partPath: part.partPath, triangles: part.triangles, surfaceCount: part.surfaces.order.length, boundsMm: part.boundsMm.map(readable),
  })) }
}

function surfacePage(part, offset) {
  const data = part.surfaces
  return { partPath: part.partPath, total: data.order.length, surfaces: Array.from(data.order.subarray(offset, offset + pageSize), row => ({
    surfaceId: data.surfaceIds[row], triangles: data.triangles[row], areaMm2: readable(data.areas[row]),
    centerMm: vector(data.centers, row), boundsMm: [...vector(data.minimums, row), ...vector(data.maximums, row)],
    meanNormal: vector(data.normals, row),
  })) }
}

async function readCoverageMap(target, sourceHash, signal) {
  const path = target.replace(/\.usda?$/iu, '.regions.json')
  try {
    const actual = await realpath(path)
    const within = relative(dirname(target), actual)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Keep the region map inside the model folder.')
    const info = await stat(actual)
    if (!info.isFile() || info.size > MAX_REGION_MAP_BYTES) throw new Error('Supply a region map file of up to 2 MiB.')
    const bytes = await readFile(actual, { signal })
    if (bytes.byteLength > MAX_REGION_MAP_BYTES) throw new Error('Region map exceeds 2 MiB.')
    const value = JSON.parse(bytes.toString('utf8'))
    const map = readModelRegions(value, sourceHash)
    if (!map) return { status: 'outdated_region_map', message: 'Save a map for the current USD revision before auditing.' }
    return { status: 'read', regions: map.regions, key: createHash('sha256').update(bytes).digest('hex') }
  } catch (error) {
    signal.throwIfAborted()
    if (error.code === 'ENOENT') return { status: 'missing_region_map', message: 'Save a region map beside the USD before auditing.' }
    return { status: 'invalid_region_map', message: String(error.message).slice(0, 500) }
  }
}

function coverageCounts(value) {
  return { triangles: value.triangles, uncoveredTriangles: value.uncoveredTriangles,
    areaMm2: readable(value.areaMm2), uncoveredAreaMm2: readable(value.uncoveredAreaMm2) }
}

async function coveragePage(audit, partPath, offset, cwd, signal) {
  const coverage = coverageCounts(audit)
  if (!partPath) {
    const uncoveredParts = audit.parts.filter(part => part.uncoveredTriangles)
      .sort((a, b) => b.uncoveredAreaMm2 - a.uncoveredAreaMm2)
    const parts = uncoveredParts.slice(offset, offset + pageSize).map(part => ({
      partPath: part.partPath, ...coverageCounts(part), uncoveredSurfaceCount: part.surfaces.length,
    }))
    return { coverage, total: uncoveredParts.length, parts }
  }
  const part = audit.parts.find(part => JSON.stringify(part.partPath) === JSON.stringify(partPath))
  if (!part) throw new Error('Unknown partPath. Copy the array from this model’s parts listing.')
  const surfaces = []
  for (const row of part.surfaces.slice(offset, offset + pageSize)) {
    const { surfaceId, triangles, surfaceTriangles, areaMm2, boundsMm, faceRanges } = row
    const selection = triangles === surfaceTriangles ? { surfaceIds: [surfaceId] }
      : faceRanges.length <= inlineRangeLimit ? { faceRanges }
        : { faceRangesPath: await saveAnalyzedRanges(cwd, faceRanges, signal) }
    surfaces.push({ surfaceId, triangles, surfaceTriangles, areaMm2: readable(areaMm2), boundsMm: boundsMm.map(readable), ...selection })
  }
  return { coverage, partPath, partCoverage: coverageCounts(part), total: part.surfaces.length, surfaces }
}

/**
 * Register saved USD analysis independently of the current viewer selection.
 * @param {object} ctx Print Studio host with project-owned working directories and tool registry.
 * @param {Function} defineTool DSH tool definition factory.
 * @returns {void}
 */
export function registerSurfaceAnalysis(ctx, defineTool) {
  let latest
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(); latest = undefined }, 'print viewer: surface analysis lifetime')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'viewer_analyze_surfaces',
    description: 'Inspect the saved USD for naming. Lists parts and connected surfaces with bounds, centres, normals and triangle counts. Can audit a saved region map for unnamed triangles. See name-model-regions.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project-relative saved .usda or .usd model.' },
      partPath: { type: 'array', items: { type: 'string' }, description: 'Copy a partPath array from the parts listing to inspect its surfaces.' },
      sourceHash: { type: 'string', description: 'SHA-256 from the first page to require the same revision.' },
      offset: { type: 'integer', description: 'nextOffset from a previous page. Coverage pagination requires both revision keys.' },
      includeMesh: { type: 'boolean', description: 'With partPath, also save the whole part as a binary STL in viewer triangle order and model-local millimetres for selecting faceRanges.' },
      coverage: { type: 'boolean', description: 'Audit the saved region map. Omit partPath to list parts with gaps. Supply partPath for uncovered surface selections.' },
      regionMapKey: { type: 'string', description: 'With coverage, copy the first result’s regionMapKey for further pages on the same map.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 120_000,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      signal.throwIfAborted()
      if (isAbsolute(args.path) || !['.usda', '.usd'].includes(extname(args.path).toLowerCase())) throw new Error('Use a project-relative saved USD path')
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw new Error('Supply a nonnegative integer offset')
      if (args.includeMesh && !args.partPath) throw new Error('Supply a partPath from the parts listing to export a mesh')
      if (args.regionMapKey !== undefined && !args.coverage) throw new Error('Use regionMapKey with coverage')
      if (args.coverage && args.offset && (!args.sourceHash || !args.regionMapKey)) throw new Error('Copy sourceHash and regionMapKey before paging through coverage')
      const cwd = await realpath(await ctx.workingDirectory.ensure(exec.agent, signal))
      const target = await realpath(resolve(cwd, args.path))
      const within = relative(cwd, target)
      if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('USD analysis must stay inside the project')
      const info = await stat(target)
      if (!info.isFile() || info.size > USD_MAX_BYTES) throw new Error('Supply a saved USD file of up to 64 MiB')
      const bytes = await readFile(target, { signal })
      if (bytes.byteLength > USD_MAX_BYTES) throw new Error('USD exceeds 64 MiB')
      const sourceHash = createHash('sha256').update(bytes).digest('hex')
      if (args.sourceHash && args.sourceHash !== sourceHash) {
        return JSON.stringify({ status: 'stale_model', path: args.path, sourceHash, message: 'Read the parts for this revision before naming features.' })
      }
      let map
      if (args.coverage) {
        map = await readCoverageMap(target, sourceHash, signal)
        if (map.status !== 'read') return JSON.stringify({ ...map, path: args.path, sourceHash })
        if (args.regionMapKey !== undefined && args.regionMapKey !== map.key) {
          return JSON.stringify({ status: 'stale_region_map', path: args.path, sourceHash, regionMapKey: map.key, message: 'Restart the audit for the changed region map.' })
        }
      }
      let inventory = latest?.hash === sourceHash && (!map || latest.regionMapKey === map.key) ? latest.inventory : undefined
      if (!inventory) {
        inventory = await loadInventory(bytes, map?.regions, signal)
        signal.throwIfAborted()
        latest = { hash: sourceHash, regionMapKey: map?.key, inventory }
      }
      const offset = args.offset ?? 0
      const identity = { path: args.path, sourceHash, ...(map ? { regionMapKey: map.key } : {}) }
      let page
      if (map) {
        const audit = inventory.coverage
        if (audit.unresolvedIds.length) {
          return JSON.stringify({ status: 'invalid_region_map', ...identity, unresolvedIds: audit.unresolvedIds,
            message: 'Repair these unresolved region selectors before auditing coverage.' })
        }
        page = await coveragePage(audit, args.partPath, offset, cwd, signal)
      } else if (args.partPath) {
        const key = JSON.stringify(args.partPath)
        const part = inventory.parts.find(part => JSON.stringify(part.partPath) === key)
        if (!part) throw new Error('Unknown partPath. Copy the array from this model’s parts listing.')
        page = surfacePage(part, offset)
      } else page = partPage(inventory.parts, offset)
      if (args.includeMesh) {
        const part = inventory.parts.find(part => JSON.stringify(part.partPath) === JSON.stringify(args.partPath))
        page.mesh = await saveAnalyzedMesh(cwd, inventory.positions.subarray(part.firstFace * 9, (part.firstFace + part.triangles) * 9), signal)
      }
      signal.throwIfAborted()
      return JSON.stringify({ status: 'analyzed', ...identity, ...page, nextOffset: offset + pageSize < page.total ? offset + pageSize : null })
    },
  })), 'print viewer: analyze saved surfaces')
}
