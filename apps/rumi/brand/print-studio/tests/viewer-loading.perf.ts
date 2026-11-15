/** CPU and retained-memory diagnostic for complete USD preview preparation; excludes transport and GPU work. */
import * as THREE from 'three'
import { parseUsdModel } from '../viewer/viewport/usd.js'
import { createHighlight } from '../viewer/viewport/highlight.js'
import { analyzeMesh } from '../viewer/checks.js'
import { placeMesh } from '../viewer/transform.js'
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js'
import { USDLoader } from 'three/addons/loaders/USDLoader.js'
const size = process.argv[2] ?? 'large'
const g = size === 'small' ? new THREE.SphereGeometry(100,32,16) : new THREE.SphereGeometry(100,400,220)
const triangles = g.index!.count / 3
const points = Array.from({ length:g.attributes.position.count },(_,i)=>`(${g.attributes.position.getX(i)/1000}, ${g.attributes.position.getY(i)/1000}, ${g.attributes.position.getZ(i)/1000})`).join(', ')
const text = `#usda 1.0\n(\n defaultPrim = "Model"\n metersPerUnit = 1\n upAxis = "Z"\n)\ndef Xform "Model" (\n prepend apiSchemas = ["IsaacRobotAPI", "PhysicsArticulationRootAPI"]\n)\n{\n rel isaac:physics:robotLinks = </Model/Mesh>\n rel isaac:physics:robotJoints = None\n def Mesh "Mesh" (\n prepend apiSchemas = ["IsaacLinkAPI", "PhysicsRigidBodyAPI", "PhysicsCollisionAPI"]\n )\n {\n point3f[] points = [${points}]\n int[] faceVertexCounts = [${Array(triangles).fill(3).join(', ')}]\n int[] faceVertexIndices = [${Array.from(g.index!.array).join(', ')}]\n uniform token subdivisionScheme = "none"\n }\n}\n`
const buffer = new TextEncoder().encode(text).buffer
global.gc?.()
const baseline = process.memoryUsage()
const phases: { name: string; ms: number; cpu: NodeJS.CpuUsage; before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage }[] = []
async function measure<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const before = process.memoryUsage()
  const cpu = process.cpuUsage()
  const start = performance.now()
  const result = await fn()
  const ms = performance.now() - start
  phases.push({ name, ms, cpu: process.cpuUsage(cpu), before, after: process.memoryUsage() })
  return result
}
const mode=process.argv[3] ?? 'complete'
let model, overlay, analysis, placed, parsed
if(mode==='parse-only') parsed = await measure('USDAParser.parseData',()=>new USDAParser().parseData(text))
else if(mode==='loader-only') parsed = await measure('USDLoader.parse',()=>new USDLoader().parse(text))
else {
  model = await measure('parseUsdModel',()=>parseUsdModel(buffer))
  placed = await measure('placeMesh-discarded-validation',()=>placeMesh(model.positions))
  placed = await measure('placeMesh-measurement',()=>placeMesh(model.positions))
  analysis = await measure('analyzeMesh',()=>analyzeMesh(placed.positions))
  overlay = await measure('createHighlight-empty-blobs',()=>createHighlight(model.root,{ blobs:[] }))
}
global.gc?.()
let surfaceCount = 0
model?.root.traverse((node) => {
  if (node instanceof THREE.Mesh) surfaceCount += node.geometry.userData.rumiSurfaceIndex?.count ?? 0
})
console.log(JSON.stringify({
  size, mode, triangles, usdBytes: buffer.byteLength, runtime: process.version, baseline, phases,
  retained: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS,
  modelTriangles: model ? model.positions.length / 9 : undefined, surfaceCount,
  retainedOutputs: Boolean(overlay && analysis),
}))
if (parsed) console.error('retained parser/loader result',Object.keys(parsed).length)
