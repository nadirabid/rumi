/** Hand a sliced 3MF to Bambu Connect for the adult's Send confirmation. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Bambu's official desktop relay. */
export const BAMBU_CONNECT_APP = '/Applications/Bambu Connect.app'

/** Rumi-owned directory for Bambu Connect and Bambu Studio. @returns {string} */
export function managedAppRoot() {
  return join(process.env.DSH_RUMI_HOME || process.env.DSH_HOME || join(homedir(), '.rumi'), 'print-studio', 'applications')
}

/** Locate a managed or separately installed copy. @returns {string | null} */
export function findBambuConnect() {
  return [join(managedAppRoot(), 'Bambu Connect.app'), BAMBU_CONNECT_APP,
    join(homedir(), 'Applications', 'Bambu Connect.app')].find(path => existsSync(join(path, 'Contents', 'MacOS', 'Bambu Connect'))) ?? null
}

/** Whether Bambu Connect is installed. */
export function hasBambuConnect() {
  return findBambuConnect() !== null
}

/**
 * Open Bambu Connect with one sliced file ready for review.
 * @param {string} filePath - absolute .3mf or .gcode.3mf path.
 * @param {string} name - display name in Bambu Connect.
 * @returns {Promise<{ app: string, file: string, manualSend: true }>}
 */
export async function handoffToBambuConnect(filePath, name) {
  const app = findBambuConnect()
  if (app === null) throw new Error('Set up Bambu Connect in Plugins → Print Studio before printing')
  if (!existsSync(filePath)) throw new Error(`Sliced file not found: ${filePath}`)
  const url = `bambu-connect://import-file?${new URLSearchParams({
    path: filePath,
    name,
    version: '1.0.0',
  }).toString()}`
  await execFileAsync('/usr/bin/open', ['-a', app, url], { timeout: 30_000 })
  return { app, file: filePath, manualSend: true }
}
