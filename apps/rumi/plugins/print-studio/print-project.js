/** Resolve print project membership from the local project catalog. */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

const projectIdPattern = /^[a-f0-9-]{36}$/u

/** Read a registered print project by its workspace ID. @param {string} workspace @param {string} id @returns {object|null} Project metadata. */
export function projectById(workspace, id) {
  if (!projectIdPattern.test(id)) return null
  try {
    const root = realpathSync(workspace)
    const path = join(root, id)
    if (realpathSync(path) !== path) return null
    const file = openSync(join(path, 'project.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(file)
      if (!info.isFile() || info.size > 1_048_576) return null
      const metadata = JSON.parse(readFileSync(file, 'utf8'))
      if (metadata?.id !== id || metadata.type !== 'print' || typeof metadata.name !== 'string' || !Array.isArray(metadata.sessionIds)) return null
      return { id, path, name: metadata.name, type: metadata.type, sessionIds: metadata.sessionIds }
    } finally { closeSync(file) }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return null
    throw error
  }
}

/** Locate the print project containing this conversation. @param {object} scope @param {object} session @returns {object|null} Project metadata. */
export function owningProject(scope, session) {
  const cwd = session.header.cwd
  if (!cwd || !projectIdPattern.test(basename(cwd))) return null
  const project = projectById(scope.workspaceRoot, basename(cwd))
  if (!project || !project.sessionIds.includes(session.id) || realpathSync(cwd) !== project.path) return null
  return project
}
