/** Locate Blender for agent-owned shell execution; never execute project scripts in the host. */
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Resolve an explicit override, the packaged runtime, or a development installation.
 * @param {string} configured - Explicit executable; empty enables discovery.
 * @param {string} home - Rumi home for app-owned tools.
 * @returns {Promise<object>} Ready paths or an actionable missing/invalid status.
 */
export async function blenderStatus(configured, home) {
  const moduleParts = fileURLToPath(import.meta.url).split(sep)
  const archiveIndex = moduleParts.findIndex(part => part === 'app.asar' || part === 'app.asar.unpacked')
  const bundled = archiveIndex === -1 ? null : join(moduleParts.slice(0, archiveIndex).join(sep),
    'runtime', 'blender', process.platform === 'win32' ? 'Blender/blender.exe' : 'blender')
  const candidates = configured ? [configured] : bundled !== null ? [bundled] : [
    join(home, 'tools', 'blender', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
    '/Applications/Blender.app/Contents/MacOS/Blender',
    join(homedir(), 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
  ]
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      return { status: 'ready', executable: await realpath(path),
        helper: fileURLToPath(new URL('./rumi_blender.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
        skill: 'blender-modeling',
        execution: 'Use the shell tool: executable --background --factory-startup --python-exit-code 1 --python script.py. Blender runs locally without a window. Read blender-modeling before editing.',
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  return { status: configured ? 'invalid_executable' : bundled !== null ? 'bundled_unavailable' : 'not_installed',
    message: configured ? 'Correct Print Studio blenderExecutable; the configured path is unavailable or not executable.'
      : bundled !== null ? 'The Blender runtime bundled with Rumi is missing or unavailable. Reinstall or update Rumi; do not use an unrelated Blender installation silently.'
      : 'For development, install Blender in /Applications/Blender.app, or configure Print Studio blenderExecutable. Do not substitute procedural preview geometry for the requested Blender edit.' }
}

/**
 * Register read-only Blender discovery through the existing tool service.
 * @param {object} ctx - Plugin context.
 * @param {Function} defineTool - Host tool factory.
 * @param {object} config - Resolved Print Studio configuration.
 * @returns {void}
 */
export function applyBlender(ctx, defineTool, config) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'blender_status',
    description: 'Find the local Blender executable and Rumi export helper. Use Blender background Python scripts for mesh creation and editing, then viewer_load the exported GLB for Three.js viewing and iteration. Read the blender-modeling skill. This tool only discovers paths; scripts run through the existing shell tool and its permissions.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: () => ({ card: 'generic', title: 'Find Blender', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute() { return JSON.stringify(await blenderStatus(config.blenderExecutable, config.blenderHome)) },
  })), 'print-studio: Blender discovery')
}
