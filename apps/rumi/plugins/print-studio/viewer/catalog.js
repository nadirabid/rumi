/** Discover independent model entries without executing project code. */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createHistory } from './document.js'

async function stat(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/**
 * List canonical models/<name>/model.usda before legacy GLB and JavaScript entries.
 * Symlinks are excluded; helpers are not model entries.
 * @param {string} cwd - Project directory.
 * @returns {Promise<Array<{name: string, path: string}>>} Sorted project-relative entries.
 */
export async function discoverModels(cwd) {
  const models = []
  const root = join(cwd, 'models')
  if ((await stat(root))?.isDirectory()) {
    const entries = await readdir(root, { withFileTypes: true })
    for (const directory of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!directory.isDirectory() || directory.name.startsWith('.')) continue
      for (const file of ['model.usda', 'model.usd', 'model.glb', 'model.js', 'model.mjs']) {
        const path = `models/${directory.name}/${file}`
        if (!(await stat(join(cwd, path)))?.isFile()) continue
        models.push({ name: directory.name, path })
        break
      }
    }
  }
  if ((await stat(join(cwd, 'source')))?.isDirectory()
    && (await stat(join(cwd, 'source/model.js')))?.isFile()) {
    models.push({ name: 'model', path: 'source/model.js' })
  }
  return models
}

/**
 * Read the last selected entry. Missing state means no saved selection.
 * @param {string} cwd - Project directory.
 * @returns {Promise<object | null>} Project-relative entry and saved plate dimensions; older records have no volume.
 */
export async function readSelection(cwd) {
  const path = join(cwd, '.rumi-viewer.json')
  const info = await stat(path)
  if (!info) return null
  if (!info.isFile() || info.size > 16_384) throw new Error('Invalid viewer selection file')
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value?.version !== 1 || typeof value.path !== 'string') throw new Error('Invalid viewer selection file')
  return {
    path: value.path,
    volume: value.volume === undefined ? null : createHistory().apply({ type: 'setVolume', volume: value.volume }).volume,
  }
}

/**
 * Atomically save selection in the canonical project directory.
 * @param {string} cwd - Project directory.
 * @param {string} path - Project-relative model entry.
 * @param {object | null} volume - Plate dimensions in millimetres, or no print context.
 * @returns {Promise<void>} Resolves after replacement.
 */
export async function saveSelection(cwd, path, volume) {
  await writeFileAtomic(join(await realpath(cwd), '.rumi-viewer.json'), JSON.stringify({ version: 1, path, volume }) + '\n', { mode: 0o600 })
}
