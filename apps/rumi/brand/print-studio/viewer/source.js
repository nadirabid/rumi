/** Versioned local model modules. Source is served as data; only the renderer executes it. */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { normalizeHighlight } from './highlight.js'
import { normalizePlacement } from './transform.js'

const ROUTE = '/api/print-studio/viewer'
const MAX_FILES = 64
const MAX_BYTES = 2 * 1024 * 1024

function inside(root, path) {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep)
}

/**
 * Own source snapshots and their routes for one conversation.
 * @param {object} ctx - Host context providing connection routes.
 * @param {string} path - Absolute entry file.
 * @param {string} workspace - Session workspace, containing the source directory.
 * @returns {Promise<object>} Source handle with poll, state, feedback, and dispose methods.
 */
export async function createSource(ctx, path, workspace) {
  let root, entryName
  let closed = false
  let pending, hash, candidate
  let sourceError = null
  let buildError = null
  const snapshots = []
  const state = { path, revision: 0, url: null, transform: normalizePlacement(), report: null, camera: null, highlight: null }

  async function scan() {
    const files = new Map()
    let bytes = 0, entries = 0
    async function visit(directory) {
      for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > 512) throw new Error('Keep model source in a dedicated folder with at most 512 entries')
        if (item.name.startsWith('.') || item.name === 'node_modules') continue
        const path = resolve(directory, item.name)
        if (item.isSymbolicLink()) throw new Error('Model source folders cannot contain symbolic links')
        if (item.isDirectory()) { await visit(path); continue }
        if (!item.isFile() || !['.js', '.mjs'].includes(extname(path))) continue
        if (!inside(root, await realpath(path))) throw new Error('Model source must remain inside its source folder')
        if ((await stat(path)).size > MAX_BYTES - bytes) throw new Error('Model source exceeds 2 MiB')
        const content = await readFile(path)
        bytes += content.length
        if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new Error('Model source exceeds 64 modules or 2 MiB')
        files.set(relative(root, path).split(sep).join('/'), content)
      }
    }
    await visit(root)
    if (!files.has(entryName)) throw new Error('The model entry file is missing')
    const digest = createHash('sha256')
    for (const [name, content] of files) digest.update(name).update('\0').update(content).update('\0')
    return { files, hash: digest.digest('hex') }
  }

  async function update(initial) {
    try {
      const next = await scan()
      if (closed) return
      if (next.hash === hash) {
        candidate = null
        sourceError = null
        return
      }
      // Two identical observations avoid rebuilding in the middle of a multi-file save.
      if (!initial && candidate !== next.hash) { candidate = next.hash; return }
      const prefix = `${ROUTE}/source/${randomUUID()}`
      const disposeSnapshot = ctx.effect(function* () {
        for (const [name, content] of next.files) {
          yield ctx.connection.fetch.register({
            path: `${prefix}/${name.split('/').map(encodeURIComponent).join('/')}`,
            methods: ['GET'], requestBody: 'buffered',
            fetch: async () => new Response(content, { headers: {
              'content-type': 'text/javascript; charset=utf-8',
              'cache-control': 'private, max-age=3600, immutable',
              'x-content-type-options': 'nosniff',
            } }),
          })
        }
      }, 'print viewer: source snapshot')
      snapshots.push(disposeSnapshot)
      candidate = null
      hash = next.hash
      state.url = `${prefix}/${entryName.split('/').map(encodeURIComponent).join('/')}`
      state.revision++
      state.highlight = null
      sourceError = null
      buildError = null
      state.report = null
      while (snapshots.length > 8) await snapshots.shift()()
    } catch (error) {
      if (closed) return
      sourceError = { kind: 'source', message: error instanceof Error ? error.message : String(error) }
      if (initial) throw error
    }
  }

  const dispose = ctx.effect(async function* () {
    yield async () => {
      closed = true
      await pending
      await Promise.all(snapshots.splice(0).map(release => release()))
    }
    const project = await realpath(workspace)
    const entry = await realpath(path)
    if (!inside(project, entry) || !['.js', '.mjs'].includes(extname(entry))) {
      throw new Error('viewer_load requires a .js or .mjs file inside the project')
    }
    root = dirname(entry)
    entryName = relative(root, entry).split(sep).join('/')
    state.path = entry
    await update(true)
  }, 'print viewer: source lifetime')
  await dispose
  return {
    state: () => ({ ...state, error: sourceError ?? buildError }),
    poll() {
      if (closed) return Promise.resolve()
      if (!pending) pending = update(false).finally(() => { pending = undefined })
      return pending
    },
    transform(value) {
      state.transform = normalizePlacement({ ...state.transform, ...value })
      state.report = null
    },
    highlight(value) {
      if (closed) return { status: 'closed' }
      if (value.path !== state.path || value.revision !== state.revision || value.url !== state.url || sourceError || buildError || candidate) {
        return { status: 'stale_model', message: 'Read mesh_state and resolve model errors before highlighting again.' }
      }
      const next = normalizeHighlight(value)
      state.highlight = next.blobs.length ? { ...next, id: randomUUID() } : null
      return { status: state.highlight ? 'queued' : 'cleared', highlight: state.highlight,
        message: 'Presentation state updated; viewer display and user confirmation are not acknowledged.' }
    },
    camera(value) { state.camera = { ...value, id: randomUUID() } },
    feedback(value) {
      if (value.revision !== state.revision || value.url !== state.url
        || JSON.stringify(value.transform) !== JSON.stringify(state.transform)) return
      if (value.report) {
        const report = value.report
        if (!['ok', 'review', 'blocked'].includes(report.status)
          || !report.dimensions || !['x', 'y', 'z'].every(axis => Number.isFinite(report.dimensions[axis]) && report.dimensions[axis] >= 0)
          || !Array.isArray(report.checks) || report.checks.length > 100
          || !report.checks.every(check => check && typeof check.code === 'string' && ['ok', 'warning', 'error', 'pending'].includes(check.severity))) {
          throw new Error('Invalid model measurement report')
        }
      }
      state.report = value.report ?? null
      buildError = value.error ? { kind: 'build', message: String(value.error).slice(0, 2000) } : null
    },
    dispose,
  }
}
