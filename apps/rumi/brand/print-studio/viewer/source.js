/** Versioned local model modules. Source is served as data; only the renderer executes it. */
import { readdir, readFile, realpath, stat, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateGlb, GLB_MAX_BYTES } from './glb.js'
import { normalizeHighlight } from './highlight.js'
import { normalizePlacement } from './transform.js'
import { normalizeShape, normalizeValues } from './analog/spec.js'
import { controlValues, parameterValues } from './analog/control-spec.js'

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
  const format = extname(path).toLowerCase() === '.glb' ? 'glb' : 'javascript'
  let closed = false
  let pending, hash, candidate
  let sourceError = null
  let buildError = null
  const snapshots = []
  const state = { path, format, revision: 0, url: null, transform: normalizePlacement(), report: null, camera: null, highlight: null, analog: null, contentHash: null, parameters: {} }

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
    if (format === 'glb') {
      const file = resolve(root, entryName)
      if (!inside(root, await realpath(file))) throw new Error('GLB must remain inside its model folder')
      if ((await stat(file)).size > GLB_MAX_BYTES) throw new Error('GLB exceeds 64 MiB')
      const content = await readFile(file)
      validateGlb(content)
      files.set(entryName, content)
    } else await visit(root)
    if (!files.has(entryName)) throw new Error('The model entry file is missing')
    const digest = createHash('sha256')
    for (const [name, content] of files) digest.update(name).update('\0').update(content).update('\0')
    let parameters = {}
    if (format === 'javascript') {
      const metadata = resolve(root, '.rumi-parameters.json')
      try {
        if (!inside(root, await realpath(metadata)) || (await stat(metadata)).size > 8192) throw new Error('Invalid saved model parameters')
        parameters = parameterValues(JSON.parse(await readFile(metadata, 'utf8')))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      digest.update(JSON.stringify(parameters))
    }
    return { files, hash: digest.digest('hex'), parameters }
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
              'content-type': format === 'glb' ? 'model/gltf-binary' : 'text/javascript; charset=utf-8',
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
      state.analog = null
      state.contentHash = format === 'glb' ? createHash('sha256').update(next.files.get(entryName)).digest('hex') : next.hash
      state.parameters = next.parameters
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
    if (!inside(project, entry) || !['.js', '.mjs', '.glb'].includes(extname(entry).toLowerCase())) {
      throw new Error('viewer_load requires a .glb, .js or .mjs file inside the project')
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
        return { status: 'stale_model', message: 'Read the current meshState context and resolve model errors before highlighting again.' }
      }
      if (state.analog?.operation === 'cut') return { status: 'active_cut', message: 'The cut owns its continuous plane guide. Finish or discard this edit before adding a different region highlight.' }
      const next = normalizeHighlight(value)
      state.highlight = next.blobs.length ? { ...next, id: randomUUID() } : null
      return { status: state.highlight ? 'queued' : 'cleared', highlight: state.highlight,
        message: 'Presentation state updated; viewer display and user confirmation are not acknowledged.' }
    },
    shape(value) {
      if (value.path !== state.path || value.revision !== state.revision || value.url !== state.url || sourceError || buildError || candidate) throw new Error('Model changed; read the current meshState context again')
      if ((value.operation === 'parameters') !== (format === 'javascript')) throw new Error('Parameter controls require a JavaScript model; deformation controls require a GLB')
      state.analog = { ...normalizeShape(value), id: randomUUID(), frozen: false, freezeRequested: false, rendered: false, editRevision: 0 }
      if (state.analog.operation === 'cut') state.highlight = null
      return state.analog
    },
    shapeFeedback(value) {
      const shape = state.analog
      if (!shape || value.id !== shape.id || value.url !== state.url || shape.frozen) return false
      if (value.status === 'viewer_hidden' || value.status === 'render_failed') {
        if (value.status === 'render_failed' && (typeof value.error !== 'string' || !value.error)) throw new Error('Report the control rendering error')
        shape.rendered = false
        shape.error = { kind: value.status, message: value.status === 'render_failed' ? value.error.slice(0, 2000) : 'Bring Rumi to the foreground to show the controls.' }
        return true
      }
      if (value.status === 'adjusted' || value.status === 'frozen') {
        if (!Number.isSafeInteger(value.sequence) || value.sequence <= shape.editRevision) return false
        if (value.status === 'frozen' && !shape.freezeRequested) throw new Error('Freeze was not requested')
        shape.values = controlValues(shape, value.values)
        if (shape.operation !== 'parameters') normalizeValues(shape.values)
        shape.editRevision = value.sequence
        if (value.status === 'frozen') { shape.frozen = true; state.highlight = null }
      } else if (value.status !== 'rendered') throw new Error('Unknown shape feedback')
      shape.rendered = true
      shape.error = null
      return true
    },
    requestShapeFreeze(id) { if (id !== state.analog?.id || !state.analog.rendered) throw new Error('Read the rendered controls first'); state.analog.freezeRequested = true },
    freezeShape(id) {
      if (id !== state.analog?.id || !state.analog.rendered || !state.analog.frozen || sourceError || buildError || candidate) throw new Error('Read the rendered shape controls before applying')
      state.analog.frozen = true
      return { ...state.analog, source: state.path, sourceHash: state.contentHash }
    },
    clearShape(id) { if (id !== state.analog?.id) throw new Error('Shape controls changed'); state.analog = null; state.highlight = null },
    async saveParameters(id) {
      if (format !== 'javascript' || state.analog?.operation !== 'parameters' || state.analog.id !== id || !state.analog.frozen) throw new Error('Freeze parameter controls before saving')
      if (state.analog.finish === 'blender') throw new Error('This preview must be finished in Blender using its frozen recipe')
      const values = { ...state.parameters, ...controlValues(state.analog, state.analog.values) }
      if ((await scan()).hash !== state.contentHash || !inside(await realpath(workspace), await realpath(root))) throw new Error('Model changed before parameter save')
      const temporary = resolve(root, `.rumi-parameters-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(values)+'\n', { mode: 0o600, flag: 'wx' })
      try { await rename(temporary, resolve(root, '.rumi-parameters.json')) }
      finally { await rm(temporary, { force: true }) }
      await update(true)
      if (sourceError) throw new Error(sourceError.message)
      return { parameters: { ...state.parameters }, revision: state.revision }
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
      const parameters = value.parameters === undefined ? state.parameters : parameterValues(value.parameters)
      state.report = value.report ?? null
      if (value.report) state.parameters = parameters
      buildError = value.error ? { kind: 'build', message: String(value.error).slice(0, 2000) } : null
    },
    dispose,
  }
}
