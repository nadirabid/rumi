/**
 * Rumi projects — host half.
 *
 * A project is a directory under `~/.rumi/workspace/<id>/` with an immutable id
 * and a mutable name. The directory holds the artifacts an agent produces, the
 * source it edits, and imported references, so a session's working directory
 * can simply be the project root.
 *
 * This half owns the filesystem and nothing else: the browser creates the DSH
 * session (it has the session controller) and records the id here.
 */
import { mkdir, readFile, readdir, writeFile, stat, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The plugin row id. */
export const name = 'rumi-projects'

/** Services this host half reaches. */
export const inject = ['connection']

const ROUTE = '/api/rumi-projects'
const SUBDIRECTORIES = ['artifacts', 'source', 'references']
const NAME_LIMIT = 80
const INSTRUCTIONS_FILE = 'AGENTS.md'
const INSTRUCTIONS_TEMPLATE = 'AGENTS_TEMPLATE.md'
const DEFAULT_TYPE = 'print'

/**
 * The instructions a Session's project carries.
 * @param {{list: () => Promise<object[]>}} store - Project store.
 * @param {string} sessionId - Session to find.
 * @returns {Promise<string>} The project's `AGENTS.md`, or '' when the Session has no project or no file.
 */
export async function projectInstructionsFor(store, sessionId) {
  for (const project of await store.list()) {
    if (!Array.isArray(project.sessionIds) || !project.sessionIds.includes(sessionId)) continue
    try {
      return await readFile(join(project.path, INSTRUCTIONS_FILE), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }
  return ''
}

/** The template every project carries, read from this package's own directory. */
const BASE_TEMPLATE = join(import.meta.dirname, INSTRUCTIONS_TEMPLATE)

/**
 * Compose a project's `AGENTS.md` from the templates that apply to it.
 *
 * The name leads so the file, and any Session reading it, states which project
 * this is; each template contributes its own headings below.
 * @param {{name: string, templates: readonly string[]}} project - Settled name and template bodies.
 * @returns Markdown body written into the project directory.
 */
export function renderProjectInstructions(project) {
  const parts = project.templates.map(template => template.trim()).filter(template => template !== '')
  return `${[`# ${project.name}`, ...parts].join('\n\n')}\n`
}

/**
 * Read one template file.
 * @param {string} path - Absolute template path.
 * @returns The template body, or null when the file is absent.
 */
async function readTemplate(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Registry of project types.
 *
 * Rumi's own plugin owns the creation flow; a project-type plugin contributes
 * what its type adds. Registration is scoped to the registering plugin, so a
 * type disappears with the plugin that declared it.
 * @returns {{register: (contribution: object) => () => void, get: (id: string) => object | null, defaultType: () => object | null}} the registry.
 */
export function createProjectTypes() {
  const types = new Map()
  return {
    register(contribution) {
      const id = contribution?.id
      if (typeof id !== 'string' || id === '') throw new Error('project type: an id is required')
      if (types.has(id)) throw new Error(`project type: ${id} is already registered`)
      const entry = {
        id,
        label: typeof contribution.label === 'string' ? contribution.label : id,
        isDefault: contribution.isDefault === true,
        templates: Array.isArray(contribution.templates) ? contribution.templates : [],
      }
      types.set(id, entry)
      return () => { types.delete(id) }
    },
    get(id) {
      return types.get(id) ?? null
    },
    /** The type a new project gets when the caller names none. */
    defaultType() {
      for (const entry of types.values()) if (entry.isDefault) return entry
      return types.values().next().value ?? null
    },
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
  })
}

function normalizeName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '') return null
  return trimmed.slice(0, NAME_LIMIT)
}

/**
 * The project directory store.
 * @param {string} root - Directory that holds one subdirectory per project.
 * @returns {object} Project listing, creation, session association, and persistent PNG cover operations.
 */
export function createProjectStore(root) {
  const directoryOf = (id) => {
    if (!/^[A-Za-z0-9-]+$/u.test(id)) throw new Error(`project: invalid id ${id}`)
    return join(root, id)
  }
  const read = async (id) => {
    const raw = await readFile(join(directoryOf(id), 'project.json'), 'utf8')
    let thumbnailVersion = null
    try { thumbnailVersion = String((await stat(join(directoryOf(id), '.preview.png'))).mtimeMs) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return { ...JSON.parse(raw), path: directoryOf(id), thumbnailVersion }
  }
  const write = async (project) => {
    const { path: _, thumbnailVersion: _thumbnail, ...metadata } = project
    await writeFile(join(directoryOf(project.id), 'project.json'), `${JSON.stringify(metadata, undefined, 2)}\n`)
    return { ...metadata, path: directoryOf(project.id) }
  }
  const allocateName = async () => {
    await mkdir(root, { recursive: true })
    let number = 1
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadata = await read(entry.name).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      const match = /^Untitled (\d+)$/u.exec(metadata?.name ?? '')
      if (match) number = Math.max(number, Number(match[1]) + 1)
    }
    // Exclusive reservations survive restarts and prevent concurrent name reuse.
    for (;;) {
      try {
        await writeFile(join(root, `.untitled-${number}`), '', { flag: 'wx' })
        return `Untitled ${number}`
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        number += 1
      }
    }
  }
  return {
    async list() {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const projects = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          projects.push(await read(entry.name))
        } catch {
          // A directory without readable metadata is not a project.
        }
      }
      return projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    },
    async create(name, options = {}) {
      const now = new Date().toISOString()
      const project = {
        id: randomUUID(),
        name: normalizeName(name) ?? await allocateName(),
        type: typeof options.type === 'string' ? options.type : null,
        sessionIds: [],
        activeSessionId: null,
        workspaceId: null,
        createdAt: now,
        updatedAt: now,
      }
      const directory = directoryOf(project.id)
      await mkdir(directory, { recursive: true })
      for (const child of SUBDIRECTORIES) await mkdir(join(directory, child), { recursive: true })
      // The instruction loader reads this file from the directory the Session
      // runs in, so a project's context travels with its folder. The body is
      // built from the name the store settled on, which may be an allocated one.
      if (typeof options.instructions === 'function') {
        await writeFile(join(directory, INSTRUCTIONS_FILE), options.instructions(project.name))
      }
      return write({ ...project, path: directory })
    },
    /** Read the saved cover; project metadata must exist before serving a file. */
    async thumbnail(id) {
      await read(id)
      return readFile(join(directoryOf(id), '.preview.png'))
    },
    /** Atomically replace a session's project cover without rewriting project metadata. */
    async saveThumbnail(sessionId, bytes) {
      const project = (await this.list()).find(item => item.sessionIds.includes(sessionId))
      if (!project) return false
      const temporary = join(directoryOf(project.id), `.preview-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(directoryOf(project.id), '.preview.png'))
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      return true
    },
    async attachSession(id, sessionId, workspaceId) {
      const project = await read(id)
      if (!project.sessionIds.includes(sessionId)) project.sessionIds.push(sessionId)
      project.activeSessionId = sessionId
      if (workspaceId !== undefined) project.workspaceId = workspaceId
      project.updatedAt = new Date().toISOString()
      return write(project)
    },
  }
}

/**
 * Register the project routes.
 * @param {object} ctx - Cordis host context with connection.
 * @param {{root?: string}} [config] - Project directory root; defaults to `~/.rumi/workspace`.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const store = createProjectStore(config.root ?? join(homedir(), '.rumi', 'workspace'))
  const types = createProjectTypes()
  // A project-type plugin contributes here instead of importing this one.
  ctx.provide('rumiProjectTypes', types)

  const instructionsFor = (sessionId) => projectInstructionsFor(store, sessionId)

  // Live Voice asks for the Session's project context when its button starts a
  // session, so the voice model knows what is being made before it speaks.
  ctx.inject(['liveVoice'], (scoped) => {
    scoped.effect(() => scoped.liveVoice.register({
      id: 'project',
      instructions: instructionsFor,
    }), 'rumi projects: live voice context')
  })
  const route = (path, methods, fetch) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods, requestBody: 'buffered', fetch,
  }), `rumi projects: ${methods.join(',')} ${ROUTE}${path}`)

  // One handler per path: the connection router keys routes by path alone.
  route('', ['GET', 'POST'], async (request) => {
    if (request.method !== 'POST') return json({ projects: await store.list() })
    const body = await request.json().catch(() => ({}))
    const type = types.get(typeof body.type === 'string' ? body.type : DEFAULT_TYPE) ?? types.defaultType()
    const base = await readTemplate(BASE_TEMPLATE)
    if (base === null) return json({ error: 'project_template_missing' }, 500)
    const templates = [base]
    for (const path of type?.templates ?? []) {
      const contributed = await readTemplate(path)
      if (contributed === null) ctx.logger?.warn(`rumi projects: type template is missing at ${path}`)
      else templates.push(contributed)
    }
    return json({
      project: await store.create(body.name, {
        type: type?.id ?? null,
        instructions: projectName => renderProjectInstructions({ name: projectName, templates }),
      }),
    }, 201)
  })
  route('/thumbnail', ['GET', 'POST'], async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json({ error: 'session_required' }, 400)
      const bytes = Buffer.from(await request.arrayBuffer())
      // Only the fixed-size viewport PNG is accepted; never serve arbitrary uploaded content.
      if (bytes.length < 24 || bytes.length > 512 * 1024
        || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.toString('ascii', 12, 16) !== 'IHDR'
        || bytes.readUInt32BE(16) !== 480 || bytes.readUInt32BE(20) !== 320) {
        return json({ error: 'invalid_thumbnail' }, 400)
      }
      return await store.saveThumbnail(sessionId, bytes)
        ? new Response(null, { status: 204 }) : json({ error: 'project_not_found' }, 404)
    }
    try {
      const bytes = await store.thumbnail(url.searchParams.get('projectId') ?? '')
      return new Response(bytes, { headers: {
        'content-type': 'image/png', 'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      } })
    } catch (error) {
      if (error.code === 'ENOENT' || !/^[A-Za-z0-9-]+$/u.test(url.searchParams.get('projectId') ?? '')) {
        return json({ error: 'thumbnail_not_found' }, 404)
      }
      throw error
    }
  })
  route('/session', ['POST'], async (request) => {
    const body = await request.json().catch(() => ({}))
    if (typeof body.projectId !== 'string' || typeof body.sessionId !== 'string') {
      return json({ error: 'project_and_session_required' }, 400)
    }
    try {
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
      return json({ project: await store.attachSession(body.projectId, body.sessionId, workspaceId) })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 404)
    }
  })
}
