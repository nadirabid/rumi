/** Run bounded mechanical probes with the packaged native Bullet executable. */
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/**
 * Resolve the configured executable or the app-owned bundle; never search PATH.
 * @param {string} configured Explicit override; empty selects the packaged helper.
 * @returns {Promise<string>} Executable path; missing dependencies reject validation.
 */
export async function bulletExecutable(configured) {
  const parts = fileURLToPath(import.meta.url).split(sep)
  const archive = parts.findIndex(part => part === 'app.asar' || part === 'app.asar.unpacked')
  const bundled = archive < 0 ? null : join(parts.slice(0, archive).join(sep), 'runtime', 'bullet', 'bin', process.platform === 'win32' ? 'rumi-bullet.exe' : 'rumi-bullet')
  const path = configured || bundled
  if (!path) throw new Error('Configure Print Studio bulletExecutable for development, or run the packaged Rumi app.')
  await access(path, constants.X_OK)
  return realpath(path)
}

/**
 * Validate assembly coverage before publishing native findings. A passing report
 * must cover every requested part, connection, sequence and removal step.
 * @param {object} report Parsed native stdout.
 * @param {object} expected Requested assembly description.
 * @returns {object} Consistent, bounded report; malformed or incomplete results throw.
 */
export function validateBulletReport(report, expected) {
  const names = values => Array.isArray(values) && values.length <= 128
    && values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 128)
    && new Set(values).size === values.length
  const sameNames = (actual, wanted) => names(actual) && actual.length === wanted.length && wanted.every(id => actual.includes(id))
  if (report?.version !== 2 || report.engine !== 'bullet' || report.printReady !== false
    || typeof report.assemblyVerified !== 'boolean'
    || !['passed', 'review', 'needs_repair'].includes(report.status)
    || !Array.isArray(report.checks) || report.checks.length > 256
    || !report.checks.every(check => typeof check.code === 'string' && check.code.length <= 128
      && ['warning', 'error'].includes(check.severity) && Number.isSafeInteger(check.count) && check.count >= 0)
    || !Array.isArray(report.connections) || report.connections.length > 128
    || typeof report.coverage?.complete !== 'boolean') throw new Error('Invalid Bullet validation report')
  const blocking = report.checks.some(check => check.count && check.severity === 'error')
  const warnings = report.checks.some(check => check.count && check.severity === 'warning')
  if (report.status !== (blocking ? 'needs_repair' : warnings ? 'review' : 'passed')
    || report.assemblyVerified !== (report.status === 'passed')
    || (report.assemblyVerified && !report.coverage.complete)) throw new Error('Inconsistent Bullet validation status')
  if (!sameNames(report.coverage.parts, expected.parts.map(part => part.id))
    || !names(report.coverage.connections) || !names(report.coverage.sequences) || !names(report.coverage.assemblySteps)) throw new Error('Invalid Bullet assembly coverage')
  const ids = new Set(expected.connections.map(item => item.id)), completed = new Set()
  for (const item of report.connections) {
    const edge = expected.connections.find(value => value.id === item.id)
    if (!edge || completed.has(item.id) || item.parent !== edge.parent || item.child !== edge.child || item.kind !== edge.kind
      || !Array.isArray(item.probes) || item.probes.length > 4096
      || item.probes.some(probe => !['passed', 'review', 'needs_repair'].includes(probe.status))) {
      throw new Error('Invalid Bullet connection coverage')
    }
    if (report.status === 'passed' && (!item.probes.length || item.probes.some(probe => probe.status !== 'passed'))) {
      throw new Error('Incomplete Bullet probe coverage')
    }
    completed.add(item.id)
  }
  if (completed.size !== ids.size || report.coverage.connections.some(id => !ids.has(id))
    || report.coverage.sequences.some(id => !(expected.sequences ?? []).some(sequence => sequence.id === id))
    || report.coverage.assemblySteps.some(id => !(expected.manufacturing?.steps ?? []).some(step => step.part === id))) {
    throw new Error('Invalid Bullet connection coverage')
  }
  if (report.coverage.complete && (!sameNames(report.coverage.connections, [...ids])
    || !sameNames(report.coverage.sequences, (expected.sequences ?? []).map(sequence => sequence.id))
    || !sameNames(report.coverage.assemblySteps, (expected.manufacturing?.steps ?? []).map(step => step.part)))) {
    throw new Error('Incomplete Bullet assembly coverage')
  }
  return report
}

/**
 * Execute only the native helper, with scrubbed environment and bounded input/output.
 * Cancellation and deadlines kill the child and await close before rejecting.
 * @param {object} config Resolved executable, timeout and mechanical settings.
 * @param {object} geometry Prepared physical bodies and assembly in millimetres, Z up.
 * @param {AbortSignal} signal Validation owner's cancellation signal.
 * @returns {Promise<object>} Checked findings; infrastructure failures never pass.
 */
export async function runBullet(config, geometry, signal) {
  signal.throwIfAborted()
  const executable = await bulletExecutable(config.bulletExecutable)
  const input = JSON.stringify({ ...geometry, version: 2, settings: config.mechanics })
  if (Buffer.byteLength(input) > 64 * 1024 * 1024) throw new Error('Mechanical geometry exceeds 64 MiB')
  signal.throwIfAborted()
  const output = await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^PYTHON/i.test(key)))
    const child = spawn(executable, [], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure, outputBytes = 0
    const stop = error => { failure ??= error; child.kill('SIGKILL') }
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > 8 * 1024 * 1024) stop(new Error('Bullet validation output exceeded 8 MiB'))
      else stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
    child.stdin.on('error', error => stop(error))
    child.on('error', error => { failure ??= error })
    const abort = () => stop(new Error('Bullet validation cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop(new Error('Bullet validation timed out')), config.mechanicsTimeoutMs)
    child.on('close', (code, killedSignal) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || killedSignal) reject(new Error(`Bullet validation failed (exit ${code}, signal ${killedSignal}): ${stderr || stdout.slice(-4000)}`))
      else resolve(stdout)
    })
    if (signal.aborted) abort()
    else child.stdin.end(input)
  })
  return validateBulletReport(JSON.parse(output), geometry.assembly)
}
