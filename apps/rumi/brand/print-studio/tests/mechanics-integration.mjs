/** Exercise the production Blender→Bullet runner using temporary physical hinge fixtures. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [blenderExecutable, bulletExecutable, packagedPlugin] = process.argv.slice(2)
assert(blenderExecutable && bulletExecutable, 'Pass Blender and rumi-bullet executable paths')
const { runValidation } = await import(packagedPlugin ? pathToFileURL(join(packagedPlugin, 'blender/validation-runner.js')).href
  : new URL('../blender/validation-runner.js', import.meta.url).href)
const directory = await mkdtemp(join(tmpdir(), 'rumi-mechanics-integration-'))
try {
  await new Promise((resolve, reject) => {
    const child = spawn(blenderExecutable, ['--python-use-system-env', '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
      '--python', fileURLToPath(new URL('./blender-mechanics.py', import.meta.url)), '--', directory],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, stdio: 'inherit' })
    let failure
    const timer = setTimeout(() => { failure = new Error('Blender fixtures timed out'); child.kill('SIGKILL') }, 60000)
    child.on('error', error => { failure = error })
    child.on('close', code => { clearTimeout(timer); failure || code !== 0 ? reject(failure ?? new Error(`Blender fixture exit ${code}`)) : resolve() })
  })
  const defaults = packagedPlugin ? (await import(pathToFileURL(join(packagedPlugin, 'index.js')).href)).Config({})
    : { validationTimeoutMs: 60000, mechanicsTimeoutMs: 120000, ...JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')) }
  const config = { ...defaults, blenderExecutable: packagedPlugin ? '' : blenderExecutable, bulletExecutable: packagedPlugin ? '' : bulletExecutable }
  for (const [variant, format] of [['normal', 'glb'], ['broken', 'glb'], ['blocked', 'glb'], ['point-touching', 'glb'], ['wheel', 'glb'], ['static', 'glb'], ['static', 'stl']]) {
    const start = performance.now()
    // Resolve frictionless hinge contacts at 0.125 ms; packaged cases use production defaults.
    const policy = !packagedPlugin && variant === 'normal'
      ? { ...config, mechanics: { ...config.mechanics, timeStepSeconds: 0.000125 } } : config
    const report = await runValidation(policy, { bytes: await readFile(join(directory, variant, `model.${format}`)), format,
      transform: { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } }, volume: null }, new AbortController().signal)
    console.log(JSON.stringify({ variant, format, durationMs: Math.round(performance.now() - start), report }))
    const success = ['normal', 'wheel', 'static'].includes(variant)
    assert.equal(report.mechanics?.status, success ? 'passed' : 'needs_repair')
    assert.equal(report.printReady, false)
    if (!success) assert.equal(report.status, 'needs_repair')
    if (variant === 'point-touching') assert(report.mechanics.checks.some(check => check.code === 'disconnected_body'))
    if (variant === 'static') {
      assert.equal(report.mechanics.assemblyVerified, true)
      assert.equal(report.mechanics.coverage.parts.length, 1)
      assert(!report.checks.some(check => check.count && check.severity === 'error'))
    }
  }
  console.log('BLENDER_BULLET_INTEGRATION_OK')
} finally { await rm(directory, { recursive: true, force: true }) }
