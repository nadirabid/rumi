/** Locate the bundled build123d CAD Python runtime for agent-owned shell execution; never execute project scripts in the host. */
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * Resolve an explicit override, the packaged CAD runtime, or a development installation.
 * @param {string} configured - Explicit executable; empty enables discovery.
 * @param {string} home - Rumi home for app-owned tools.
 * @returns {Promise<object>} Ready paths or an actionable missing/invalid status.
 */
export async function cadStatus(configured, home) {
  const modulePath = fileURLToPath(import.meta.url)
  const moduleParts = modulePath.split(sep)
  const archiveIndex = moduleParts.findIndex(part => part === 'app.asar' || part === 'app.asar.unpacked')
  const bundled = archiveIndex === -1 ? null : join(moduleParts.slice(0, archiveIndex).join(sep),
    'runtime', 'cad', process.platform === 'win32' ? 'cad-python.cmd' : 'cad-python')
  const devPython = resolve(dirname(modulePath), '../../..', '.desktop-build', 'dev-cad', 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python')
  const homePython = join(home, 'tools', 'cad', 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
  const candidates = configured ? [configured] : bundled !== null ? [bundled] : [devPython, homePython]
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      return {
        status: 'ready',
        // Preserve venv symlinks so Python resolves pyvenv.cfg beside the launcher.
        executable: resolve(path),
        helper: fileURLToPath(new URL('./rumi_cad.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
        joints: fileURLToPath(new URL('./rumi_joints.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
        skill: 'cad-modeling',
        execution: 'Use the shell tool: executable script.py. build123d runs locally in millimetres, Z up, without a window. Read cad-modeling before editing. helper["publish"] saves STEP and USDA revisions and prints RUMI_CHECKS findings. joints is the separate-print millimetre modelling kit with ready-made joint recipes; read printable-joints before modelling moving parts.',
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    }
  }
  return {
    status: configured ? 'invalid_executable' : bundled !== null ? 'bundled_unavailable' : 'not_installed',
    message: configured ? 'Correct Print Studio cadExecutable; the configured path is unavailable or not executable.'
      : bundled !== null ? 'The CAD Python runtime bundled with Rumi is missing or unavailable. Reinstall or update Rumi; do not use an unrelated Python installation silently.'
      : 'For development, provision apps/rumi/.desktop-build/dev-cad/bin/python or ~/.rumi/tools/cad/bin/python, or configure Print Studio cadExecutable. Do not substitute procedural preview geometry for the requested CAD edit.',
  }
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
 * Register CAD Python discovery through the existing tool service; ready status also writes the project's check settings.
 * @param {object} ctx - Plugin context.
 * @param {Function} defineTool - Host tool factory.
 * @param {object} config - Resolved Print Studio configuration.
 * @returns {void}
 */
export function applyCad(ctx, defineTool, config) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cad_status',
    description: 'Find the bundled build123d CAD Python executable, Rumi export helper, and separate-print joints kit. Use build123d Python scripts for B-Rep solid creation and editing in millimetres (Z up), then viewer_load the exported USD for Three.js viewing and iteration. Read the cad-modeling skill. This tool discovers paths and records the project check settings that make publish print RUMI_CHECKS findings; scripts run through the existing shell tool and its permissions.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: () => ({ card: 'generic', title: 'Find CAD engine', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const status = await cadStatus(config.cadExecutable, config.cadHome)
      if (status.status !== 'ready') return JSON.stringify(status)
      const project = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      return JSON.stringify({ ...status, checks: await writeCheckSettings(project, config.validation) })
    },
  })), 'print-studio: CAD discovery')
}
