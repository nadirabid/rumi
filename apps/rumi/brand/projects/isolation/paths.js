/** Canonical project paths and the macOS process policy for project-owned data. */
import { realpathSync, readFileSync } from 'node:fs'
import { dirname, basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolve links through the deepest existing ancestor, including targets not created yet.
 * @param {string} path Absolute candidate.
 * @returns {string} Canonical target spelling.
 */
export function canonical(path) {
  if (!isAbsolute(path)) throw new Error('Project paths must be absolute')
  try { return realpathSync(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(canonical(parent), basename(path))
  }
}

/** Test a canonical directory boundary, without accepting sibling prefixes.
 * @param {string} root Canonical directory.
 * @param {string} path Canonical candidate.
 * @returns {boolean} Whether the candidate belongs to the directory.
 */
export function contains(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

/** Resolve the registered project of a session; arbitrary working directories fail closed.
 * @param {string} workspace Managed projects directory.
 * @param {object} session Session identity and immutable header.
 * @returns {string} Canonical project directory.
 */
export function projectRoot(workspace, session) {
  const home = canonical(workspace), root = canonical(session.header.cwd)
  if (dirname(root) !== home || !/^[a-f0-9-]{36}$/u.test(basename(root))) throw new Error('Session does not belong to a Rumi project')
  const metadata = JSON.parse(readFileSync(checkedPath(root, 'project.json', false, []), 'utf8'))
  if (metadata.id !== basename(root) || !Array.isArray(metadata.sessionIds) || !metadata.sessionIds.includes(session.id)) {
    throw new Error('Session is not registered with this project')
  }
  return root
}

/** Deny data access outside a project; shared runtime grants are read-only.
 * @param {string} root Owning project.
 * @param {string} path Candidate path, relative to the project or absolute.
 * @param {boolean} write Whether the operation mutates the target.
 * @param {string[]} runtimeRoots Canonical immutable runtime directories.
 * @returns {string} Checked canonical path.
 */
export function checkedPath(root, path, write, runtimeRoots) {
  const target = canonical(resolve(root, path))
  if (contains(root, target) && (!write || target !== resolve(root, 'project.json'))) return target
  if (!write && runtimeRoots.some(runtime => contains(runtime, target))) return target
  const error = new Error('Project isolation denied access outside this project. Import the required file into this project first.')
  error.code = 'RUMI_PROJECT_ACCESS_DENIED'
  throw error
}

const quote = value => JSON.stringify(value)

/** Build kernel-enforced read/write limits inherited by all child processes.
 * @param {string} root Canonical project directory.
 * @param {string[]} runtimeRoots Canonical read-only runtime directories.
 * @returns {string} Seatbelt profile; no Apple events or unrestricted retry.
 */
export function seatbeltProfile(root, runtimeRoots) {
  const ancestors = new Set(['/'])
  for (const path of [root, ...runtimeRoots]) for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent)
  return ['(version 1)', '(allow default)', '(deny file-read*)', '(deny file-write*)',
    '(deny appleevent-send)', '(deny file-link)',
    '(deny file-write* (vnode-type SYMLINK))', '(deny file-write-create (vnode-type SYMLINK))', '(deny file-write-unlink (vnode-type DIRECTORY))', '(allow file-read* (literal "/"))',
    `(allow file-read-metadata ${[...ancestors].map(path => `(literal ${quote(path)})`).join(' ')})`,
    `(allow file-read* ${[root, ...runtimeRoots].map(path => `(subpath ${quote(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${quote(root)}))`,
    `(deny file-write* (literal ${quote(resolve(root, 'project.json'))}))`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
  ].join('\n')
}
