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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
  })
}

function normalizeName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '') return 'Untitled project'
  return trimmed.slice(0, NAME_LIMIT)
}

/**
 * The project directory store.
 * @param {string} root - Directory that holds one subdirectory per project.
 * @returns {{list: () => Promise<object[]>, create: (name?: string) => Promise<object>, attachSession: (id: string, sessionId: string) => Promise<object>}} the store.
 */
export function createProjectStore(root) {
  const directoryOf = (id) => {
    if (!/^[A-Za-z0-9-]+$/u.test(id)) throw new Error(`project: invalid id ${id}`)
    return join(root, id)
  }
  const read = async (id) => {
    const raw = await readFile(join(directoryOf(id), 'project.json'), 'utf8')
    return { ...JSON.parse(raw), path: directoryOf(id) }
  }
  const write = async (project) => {
    const { path: _, ...metadata } = project
    await writeFile(join(directoryOf(project.id), 'project.json'), `${JSON.stringify(metadata, undefined, 2)}\n`)
    return { ...metadata, path: directoryOf(project.id) }
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
    async create(name) {
      const now = new Date().toISOString()
      const project = {
        id: randomUUID(),
        name: normalizeName(name),
        sessionIds: [],
        activeSessionId: null,
        workspaceId: null,
        createdAt: now,
        updatedAt: now,
      }
      const directory = directoryOf(project.id)
      await mkdir(directory, { recursive: true })
      for (const child of SUBDIRECTORIES) await mkdir(join(directory, child), { recursive: true })
      return write({ ...project, path: directory })
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
  const route = (path, methods, fetch) => ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}${path}`, methods, requestBody: 'buffered', fetch,
  }), `rumi projects: ${methods.join(',')} ${ROUTE}${path}`)

  // One handler per path: the connection router keys routes by path alone.
  route('', ['GET', 'POST'], async (request) => {
    if (request.method !== 'POST') return json({ projects: await store.list() })
    const body = await request.json().catch(() => ({}))
    return json({ project: await store.create(body.name) }, 201)
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
