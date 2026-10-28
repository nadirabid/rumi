/** Hand a sliced 3MF to Bambu Connect for the adult's Send confirmation. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Bambu's official desktop relay. */
export const BAMBU_CONNECT_APP = '/Applications/Bambu Connect.app'

/** Whether Bambu Connect is installed. */
export function hasBambuConnect() {
  return existsSync(BAMBU_CONNECT_APP)
}

/**
 * Open Bambu Connect with one sliced file ready for review.
 * @param {string} filePath - absolute .3mf or .gcode.3mf path.
 * @param {string} name - display name in Bambu Connect.
 * @returns {Promise<{ app: string, file: string, manualSend: true }>}
 */
export async function handoffToBambuConnect(filePath, name) {
  if (!hasBambuConnect()) throw new Error('Bambu Connect is not installed')
  if (!existsSync(filePath)) throw new Error(`Sliced file not found: ${filePath}`)
  const url = `bambu-connect://import-file?${new URLSearchParams({
    path: filePath,
    name,
    version: '1.0.0',
  }).toString()}`
  await execFileAsync('/usr/bin/open', ['-a', BAMBU_CONNECT_APP, url], { timeout: 30_000 })
  return { app: BAMBU_CONNECT_APP, file: filePath, manualSend: true }
}
