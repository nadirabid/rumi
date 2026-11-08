/** Native subprocess failures stay unavailable and cancellation releases the child. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runBullet, validateBulletReport } from '../bullet/runner.js'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
const connection = { id: 'door', parent: 'frame', child: 'panel', kind: 'revolute' }
const assembly = { parts: [{ id: 'frame' }, { id: 'panel' }], connections: [connection], sequences: [] }
const report = { version: 2, engine: 'bullet', printReady: false, assemblyVerified: true, status: 'passed', checks: [],
  coverage: { parts: ['frame', 'panel'], connections: ['door'], sequences: [], assemblySteps: [], complete: true },
  connections: [{ ...connection, probes: [{ status: 'passed' }] }] }
async function helper(source: string, timeout = 5000) {
  const directory = await mkdtemp(join(tmpdir(), 'rumi-bullet-runner-'))
  cleanup.push(directory)
  const executable = join(directory, 'helper'), ready = join(directory, 'ready')
  await writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
  return { directory, ready, config: { bulletExecutable: executable, mechanicsTimeoutMs: timeout, mechanics: {} } }
}

it('publishes only complete reports for the requested assembly', async () => {
  const fixture = await helper(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(report))}));`)
  expect(await runBullet(fixture.config, { assembly }, new AbortController().signal)).toEqual(report)
  expect(() => validateBulletReport({ ...report, connections: [] }, assembly)).toThrow('coverage')
  expect(() => validateBulletReport({ ...report, connections: [{ ...connection, probes: [] }] }, assembly)).toThrow('coverage')
  expect(() => validateBulletReport({ ...report, connections: [{ ...connection, child: 'other', probes: [{ status: 'passed' }] }] }, assembly)).toThrow('coverage')
  expect(() => validateBulletReport({ ...report, coverage: { ...report.coverage, parts: ['panel'] } }, assembly)).toThrow('coverage')
  expect(() => validateBulletReport({ ...report, coverage: { ...report.coverage, connections: [] } }, assembly)).toThrow('coverage')
  expect(() => validateBulletReport(report, { ...assembly, sequences: [{ id: 'fold' }] })).toThrow('coverage')
  expect(() => validateBulletReport({ ...report, assemblyVerified: false }, assembly)).toThrow('status')
  expect(() => validateBulletReport({ ...report, coverage: { ...report.coverage, complete: false } }, assembly)).toThrow('status')
})

it('keeps unsupported assemblies unverified and rejects legacy passes', () => {
  const unsupported = { ...report, status: 'review', assemblyVerified: false,
    checks: [{ code: 'unsupported_coupled_motion', severity: 'warning', count: 1 }],
    coverage: { ...report.coverage, complete: false, connections: [] }, connections: [{ ...connection, probes: [] }] }
  expect(validateBulletReport(unsupported, assembly)).toEqual(unsupported)
  expect(() => validateBulletReport({ ...report, version: 1 }, assembly)).toThrow('Invalid')
})

it('preserves failed assembly paths as repair findings with partial coverage', async () => {
  const separate = { ...assembly, manufacturing: { mode: 'separate', steps: [{ part: 'panel', path: [[0, 0, 0], [0, 20, 0]] }] } }
  const blocked = { ...report, status: 'needs_repair', assemblyVerified: false,
    checks: [{ code: 'assembly_path_interference', severity: 'error', count: 1 }],
    coverage: { ...report.coverage, complete: false, connections: [] } }
  const fixture = await helper(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(blocked))}));`)
  expect(await runBullet(fixture.config, { assembly: separate }, new AbortController().signal)).toEqual(blocked)
  expect(() => validateBulletReport({ ...blocked, coverage: { ...blocked.coverage, assemblySteps: ['unknown'] } }, separate)).toThrow('coverage')
})

it('kills and awaits an admitted child when its validation is superseded', async () => {
  const fixture = await helper('const fs = require(\'node:fs\'); process.stdin.resume(); process.stdin.on(\'end\', () => { fs.writeFileSync(__filename + \'.ready\', String(process.pid)); setInterval(() => {}, 1000); });')
  const controller = new AbortController()
  const operation = runBullet(fixture.config, { assembly }, controller.signal)
  const settled = expect(operation).rejects.toThrow('cancelled')
  let pid = 0
  try {
    await expect.poll(async () => { try { pid = Number(await readFile(fixture.config.bulletExecutable + '.ready', 'utf8')); return pid > 0 } catch { return false } }).toBe(true)
  } finally { controller.abort() }
  await settled
  expect(() => process.kill(pid, 0)).toThrow()
})

it.each([
  ['deadline', 'process.stdin.resume(); setInterval(() => {}, 1000);', 'timed out', 100],
  ['output limit', "process.stdin.resume(); process.stdout.write('x'.repeat(1024 * 1024 + 1));", 'exceeded', 5000],
  ['nonzero exit', "process.stdin.resume(); process.stderr.write('native failure'); process.exitCode = 3;", 'native failure', 5000],
  ['invalid JSON', "process.stdin.resume(); process.stdout.write('invalid');", 'JSON', 5000],
])('does not turn %s into a passing check', async (_name, source, error, timeout) => {
  const fixture = await helper(String(source), Number(timeout))
  await expect(runBullet(fixture.config, { assembly }, new AbortController().signal)).rejects.toThrow(String(error))
})
