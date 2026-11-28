/** Host-owned intersection checks of the exact preview geometry, independent of agent assessments. */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cadStatus } from './host.js'
import { runCadCheck } from './validation-runner.js'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { meshSamples, measureControlCase } from '../viewer/analog/evidence.js'

/** Check new intersecting triangle pairs at each endpoint; source defects remain visible.
 * @param {object} config Resolved CAD configuration and timeout.
 * @param {Uint8Array} bytes Immutable saved USD.
 * @param {object} request Prepared spec and comparison cases.
 * @param {AbortSignal} signal Validation cancellation.
 * @returns {Promise<object[]>} Per-case geometry findings; infrastructure failures reject.
 */
export async function checkControlGeometry(config, bytes, request, signal) {
  const cad = await cadStatus(config.cadExecutable, config.cadHome ?? config.home)
  if (cad.status !== 'ready') throw new Error(cad.message)
  const directory = await mkdtemp(join(tmpdir(), 'rumi-control-geometry-'))
  let model
  try {
    model = await parseUsdModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const samples = meshSamples(model.root, request.spec, null)
    const points = [], parts = [], triangles = []
    for (const [part, mesh] of samples.entries()) {
      const offset = points.length, index = mesh.node.geometry.index
      for (const point of mesh.points) { points.push(point); parts.push(part) }
      for (let i = 0; i < (index?.count ?? mesh.points.length); i += 3) triangles.push([0, 1, 2].map(j => offset + (index ? index.getX(i + j) : i + j)))
    }
    const baseline = join(directory, 'baseline.json'), cases = [], output = join(directory, 'output.json')
    await writeFile(baseline, JSON.stringify({ points, parts, triangles }), { mode: 0o600, flag: 'wx' })
    for (const [index, test] of request.cases.entries()) {
      signal.throwIfAborted()
      const measured = measureControlCase(model.root, request.spec, test), path = join(directory, `${index}.json`)
      await writeFile(path, JSON.stringify(measured.meshes.flatMap(mesh => mesh.points)), { mode: 0o600, flag: 'wx' })
      cases.push({ id: test.id, path })
    }
    const path = join(directory, 'request.json')
    await writeFile(path, JSON.stringify({ baseline, cases, output }), { mode: 0o600, flag: 'wx' })
    const script = fileURLToPath(new URL('./control_geometry.py', import.meta.url)).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
    await runCadCheck(cad.executable, script, path, config.validationTimeoutMs, signal)
    const result = JSON.parse(await readFile(output, 'utf8'))
    if (result?.version !== 1 || !Array.isArray(result.cases) || result.cases.length !== cases.length
      || result.cases.some((item, i) => item.id !== cases[i].id || ['baselineIntersectionPairs', 'intersectionPairs', 'newIntersectionPairs'].some(key => !Number.isSafeInteger(item[key]) || item[key] < 0)
        || !Array.isArray(item.examples) || item.examples.length > 5)) throw new Error('Invalid control geometry report')
    return result.cases
  } finally { if (model) disposeModel(model.root); await rm(directory, { recursive: true, force: true }) }
}
