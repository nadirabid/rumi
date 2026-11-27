/** Project directory storage, atomic metadata/cover persistence, and `AGENTS.md` instruction composition. */
import { mkdir, readFile, readdir, writeFile, stat, rename, rm, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonical, checkedPath } from './isolation/paths.js'

export const SUBDIRECTORIES = ['artifacts', 'source', 'references']
export const NAME_LIMIT = 80
export const INSTRUCTIONS_FILE = 'AGENTS.md'
export const DEFAULT_NAME_PATTERN = /^Untitled \d+$/u
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9-]+$/u

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
      return await readFile(checkedPath(canonical(project.path), INSTRUCTIONS_FILE, false, []), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }
  return ''
}

/**
 * Compose a project's `AGENTS.md` from the templates that apply to it.
 * @param {{name: string, templates: readonly string[]}} project - Settled name and template bodies.
 * @returns {string} Markdown body written into the project directory.
 */
export function renderProjectInstructions(project) {
  const parts = project.templates.map(template => template.trim()).filter(template => template !== '')
  return `${[`# ${project.name}`, ...parts].join('\n\n')}\n`
}

function normalizeName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '') return null
  return trimmed.slice(0, NAME_LIMIT)
}

/** Determine whether a project's current title is a placeholder, auto-generated, or user-authored. */
export function effectiveNameSource(project) {
  if (project?.nameSource === 'default' || project?.nameSource === 'auto' || project?.nameSource === 'user') {
    return project.nameSource
  }
  return DEFAULT_NAME_PATTERN.test(project?.name ?? '') ? 'default' : 'user'
}

/**
 * The project directory store.
 * @param {string} root - Directory that holds one subdirectory per project.
 * @returns {object} Project listing, creation, renaming, removal, session association, and persistent PNG cover operations.
 */
export function createProjectStore(root) {
  const locks = new Map()
  const withLock = (id, operation) => {
    const previous = locks.get(id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    const tracked = run.finally(() => {
      if (locks.get(id) === tracked) locks.delete(id)
    })
    locks.set(id, tracked)
    return run
  }
  const directoryOf = (id) => {
    if (!PROJECT_ID_PATTERN.test(id)) throw new Error(`project: invalid id ${id}`)
    return join(root, id)
  }
  const replace = async (id, filename, bytes) => {
    const directory = directoryOf(id)
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(directory, filename))
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  const read = async (id) => {
    const raw = await readFile(join(directoryOf(id), 'project.json'), 'utf8')
    let thumbnailVersion = null
    try { thumbnailVersion = String((await stat(join(directoryOf(id), '.preview.png'))).mtimeMs) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return { ...JSON.parse(raw), path: directoryOf(id), thumbnailVersion }
  }
  const write = async (project) => {
    const { path: _, thumbnailVersion, ...metadata } = project
    await replace(project.id, 'project.json', `${JSON.stringify(metadata, undefined, 2)}\n`)
    return { ...metadata, path: directoryOf(project.id), thumbnailVersion: thumbnailVersion ?? null }
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
    async findBySession(sessionId, hintDirectory) {
      if (typeof hintDirectory === 'string' && hintDirectory !== '') {
        const candidateId = basename(hintDirectory)
        if (PROJECT_ID_PATTERN.test(candidateId)) {
          try {
            const candidate = await read(candidateId)
            if (Array.isArray(candidate.sessionIds) && candidate.sessionIds.includes(sessionId)) return candidate
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
      }
      return (await this.list()).find(item => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) ?? null
    },
    async create(name, options = {}) {
      const now = new Date().toISOString()
      const explicit = normalizeName(name)
      const project = {
        id: randomUUID(),
        name: explicit ?? await allocateName(),
        nameSource: explicit === null ? 'default' : 'user',
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
      if (typeof options.instructions === 'function') {
        await writeFile(join(directory, INSTRUCTIONS_FILE), options.instructions(project.name))
      }
      return write({ ...project, path: directory })
    },
    /** Rename a project in `project.json`; automatic updates never overwrite an explicit user name. */
    async rename(id, name, options = {}) {
      const normalized = normalizeName(name)
      if (normalized === null) throw new Error('project: name must contain visible characters')
      const source = options.source === 'user' ? 'user' : 'auto'
      directoryOf(id)
      return withLock(id, async () => {
        const project = await read(id)
        if (source === 'auto' && effectiveNameSource(project) === 'user') return { project, changed: false }
        if (project.name === normalized && project.nameSource === source) return { project, changed: false }
        project.name = normalized
        project.nameSource = source
        return { project: await write(project), changed: true }
      })
    },
    /** Delete a project directory; only a directory with readable metadata counts as a project. */
    async remove(id) {
      await readFile(join(directoryOf(id), 'project.json'))
      await rm(directoryOf(id), { recursive: true })
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
      await replace(project.id, '.preview.png', bytes)
      return true
    },
    async attachSession(id, sessionId, workspaceId) {
      directoryOf(id)
      return withLock(id, async () => {
        const project = await read(id)
        if (!project.sessionIds.includes(sessionId)) project.sessionIds.push(sessionId)
        project.activeSessionId = sessionId
        if (workspaceId !== undefined) project.workspaceId = workspaceId
        project.updatedAt = new Date().toISOString()
        return write(project)
      })
    },
  }
}
