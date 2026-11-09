/** Bounded background Blender validation of immutable input bytes. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blenderStatus } from './host.js'
import { validateUsd } from '../viewer/usd.js'
import { validateRobotAssembly } from '../viewer/mechanics.js'
import { runBullet } from '../bullet/runner.js'

/**
 * Run bundled Blender geometry checks and Bullet assembly probes with explicit policy.
 * Infrastructure failures never yield a passing report.
 * @param {object} config Resolved plugin configuration.
 * @param {object} input Immutable bytes, format, placement, and volume.
 * @param {AbortSignal} signal Owner cancellation; completion awaits process close.
 * @returns {Promise<object>} Validated structured findings.
 */
export async function runValidation(config, input, signal) {
  if (!['usd', 'stl'].includes(input.format)) throw new Error('Validation requires USD or STL')
  if (input.format === 'usd') validateUsd(input.bytes)
  const staticMetadata = validateRobotAssembly({ nodes: [{ name: 'model', mesh: 0 }] })
  let metadata
  const blender = await blenderStatus(config.blenderExecutable, config.blenderHome)
  if (blender.status !== 'ready') throw new Error(blender.message)
  const directory = await mkdtemp(join(tmpdir(), 'rumi-validation-'))
  try {
    const path = join(directory, `model.${input.format === 'usd' ? 'usda' : input.format}`), output = join(directory, 'result.json')
    await writeFile(path, input.bytes, { flag: 'wx', mode: 0o600 })
    const request = join(directory, 'request.json')
    const mechanicsOutput = join(directory, 'mechanics.json')
    await writeFile(request, JSON.stringify({ input: path, output, transform: input.transform, volume: input.volume,
      settings: config.validation,
      mechanicsOutput, ...(input.format === 'stl' ? { assembly: staticMetadata.assembly } : {}),
    }), { flag: 'wx', mode: 0o600 })
    const script = fileURLToPath(new URL('./validate.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    signal.throwIfAborted()
    await new Promise((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^PYTHON/i.test(key)))
      const child = spawn(blender.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', request],
        { env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let diagnostic = '', failure
      const collect = chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      const abort = () => { failure = new Error('Blender validation cancelled'); child.kill('SIGKILL') }
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { failure = new Error('Blender validation timed out'); child.kill('SIGKILL') }, config.validationTimeoutMs)
      child.on('error', error => { failure = error })
      child.on('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        if (failure || code !== 0) reject(failure ?? new Error(`Blender validation failed: ${diagnostic}`))
        else resolve()
      })
      if (signal.aborted) abort()
    })
    const report = JSON.parse(await readFile(output, 'utf8'))
    if (report?.version !== 1 || !['passed', 'review', 'needs_repair'].includes(report.status)
      || report.printReady !== false || !Array.isArray(report.checks) || report.checks.length > 32
      || !report.checks.every(c => typeof c.code === 'string' && Number.isSafeInteger(c.count) && c.count >= 0 && ['warning', 'error'].includes(c.severity))
      || !['x', 'y', 'z'].every(a => Number.isFinite(report.dimensions?.[a]) && report.dimensions[a] >= 0)) throw new Error('Invalid Blender validation report')
    metadata = report.robotError
      ? { declared: true, assembly: null, motionKeys: [], motionRanges: [], checks: [{ code: 'assembly_description_invalid', severity: 'error', count: 1, message: report.robotError }] }
      : report.robot ? validateRobotAssembly(report.robot) : staticMetadata
    delete report.robot
    delete report.robotError
    report.intent = { assembly: metadata.assembly, motionKeys: metadata.motionKeys, motionRanges: metadata.motionRanges }
    if (metadata.declared || metadata.checks.length) {
      let mechanics
      if (metadata.checks.length) mechanics = { version: 2, engine: 'bullet', status: 'needs_repair', assemblyVerified: false,
        checks: metadata.checks, connections: [], printReady: false }
      else if (report.status === 'needs_repair') mechanics = { status: 'blocked_by_geometry', assemblyVerified: false,
        checks: [], connections: [], printReady: false }
      else if (!metadata.assembly) mechanics = { status: 'needs_repair', assemblyVerified: false,
        checks: [{ code: 'assembly_description_required', severity: 'error', count: 1 }], connections: [], printReady: false }
      else {
        const geometry = JSON.parse(await readFile(mechanicsOutput, 'utf8'))
        mechanics = await runBullet(config, geometry, signal)
      }
      report.mechanics = mechanics
      report.checks.push(...mechanics.checks)
      report.status = report.checks.some(check => check.count && check.severity === 'error') ? 'needs_repair'
        : report.checks.some(check => check.count) || !mechanics.assemblyVerified ? 'review' : 'passed'
    }
    return report
  } finally { await rm(directory, { recursive: true, force: true }) }
}
