/** Locate Blender for agent-owned shell execution; never execute project scripts in the host. */
import { access, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
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
        joints: fileURLToPath(new URL('./rumi_joints.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
        skill: 'blender-modeling',
        execution: 'Use the shell tool: executable --background --factory-startup --python-exit-code 1 --python script.py. Blender runs locally without a window. Read blender-modeling before editing. helper["publish"] prints RUMI_CHECKS findings for each revision. joints is the millimetre modelling kit with ready-made joint recipes; read the joints skill before modelling moving parts.',
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
 * Atomically write the project's check settings for `publish()`.
 * @param {string} project - Absolute project directory.
 * @param {object} settings - Resolved Print Studio validation policy.
 * @returns {Promise<string>} Absolute path of the settings file.
 */
async function writeCheckSettings(project, settings) {
  const file = join(project, '.rumi', 'print-checks.json'), temporary = `${file}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, JSON.stringify({ version: 1, settings }) + '\n', { mode: 0o600 })
  await rename(temporary, file)
  return file
}

/**
 * Register Blender discovery through the existing tool service; ready status also writes the project's check settings.
 * @param {object} ctx - Plugin context.
 * @param {Function} defineTool - Host tool factory.
 * @param {object} config - Resolved Print Studio configuration.
 * @returns {void}
 */
export function applyBlender(ctx, defineTool, config) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'blender_status',
    description: 'Find the local Blender executable and Rumi export helper. Use Blender background Python scripts for mesh creation and editing, then viewer_load the exported USD for Three.js viewing and iteration. Read the blender-modeling skill. This tool discovers paths and records the project check settings that make publish print RUMI_CHECKS findings; scripts run through the existing shell tool and its permissions.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: () => ({ card: 'generic', title: 'Find Blender', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const status = await blenderStatus(config.blenderExecutable, config.blenderHome)
      if (status.status !== 'ready') return JSON.stringify(status)
      const project = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return JSON.stringify({ ...status, checks: await writeCheckSettings(project, config.validation) })
    },
  })), 'print-studio: Blender discovery')
}
