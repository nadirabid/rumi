/** Agent discovery of revision-bound part paths, connected surface IDs and viewer-ordered triangles. */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { USD_MAX_BYTES } from './usd.js'
import { saveAnalyzedMesh } from './cursor.js'

const pageSize = 24
const readable = value => Number(value.toPrecision(6))
const vector = (values, row) => Array.from(values.subarray(row * 3, row * 3 + 3), readable)

async function loadInventory(bytes, signal) {
  signal.throwIfAborted()
  const buffer = Uint8Array.from(bytes).buffer
  const worker = new Worker(new URL('./surface-analysis-worker.js', import.meta.url), {
    workerData: buffer, transferList: [buffer], execArgv: [],
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
    description: 'Inspect a saved USD to name physical features. Lists exact part paths, then connected Surface cursor IDs by area, with bounds, centres, normals and triangle counts. See name-model-regions.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project-relative saved .usda or .usd model.' },
      partPath: { type: 'array', items: { type: 'string' }, description: 'Copy a partPath array from the parts listing to inspect its surfaces.' },
      sourceHash: { type: 'string', description: 'SHA-256 from the first page to require the same revision.' },
      offset: { type: 'integer', description: 'nextOffset from a previous page.' },
      includeMesh: { type: 'boolean', description: 'With partPath, also save the whole part as a binary STL in viewer triangle order and model-local millimetres for selecting faceRanges.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false, timeoutMs: 120_000,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      signal.throwIfAborted()
      if (isAbsolute(args.path) || !['.usda', '.usd'].includes(extname(args.path).toLowerCase())) throw new Error('Use a project-relative saved USD path')
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw new Error('Supply a nonnegative integer offset')
      if (args.includeMesh && !args.partPath) throw new Error('Supply a partPath from the parts listing to export a mesh')
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
      let inventory = latest?.hash === sourceHash ? latest.inventory : undefined
      if (!inventory) {
        inventory = await loadInventory(bytes, signal)
        signal.throwIfAborted()
        latest = { hash: sourceHash, inventory }
      }
      const offset = args.offset ?? 0
      let page
      if (args.partPath) {
        const key = JSON.stringify(args.partPath)
        const part = inventory.parts.find(part => JSON.stringify(part.partPath) === key)
        if (!part) throw new Error('Unknown partPath. Copy the array from this model’s parts listing.')
        page = surfacePage(part, offset)
        if (args.includeMesh) {
          page.mesh = await saveAnalyzedMesh(cwd, inventory.positions.subarray(part.firstFace * 9, (part.firstFace + part.triangles) * 9), signal)
        }
      } else page = partPage(inventory.parts, offset)
      return JSON.stringify({ status: 'analyzed', path: args.path, sourceHash, ...page, nextOffset: offset + pageSize < page.total ? offset + pageSize : null })
    },
  })), 'print viewer: analyze saved surfaces')
}
