/** Browser export keeps physical part names, units and the full control range. */
import { expect, it } from 'vitest'
import { validationMesh } from '../viewer/viewport/validation.js'
import { parseGlbModel } from '../viewer/viewport/glb.js'
import { disposeModel } from '../viewer/viewport/model.js'
import { validateGlb } from '../viewer/glb.js'
import { mechanismMetadata } from '../viewer/mechanics.js'

const model = `
export const parameters = { opening: 0 };
export const motionControls = [{kind:'slider',label:'Door',axes:[{key:'opening',min:0,max:90,step:1,reset:0}]}];
export const assembly = {version:1,root:'frame',parts:[{id:'frame',mesh:'frame'},{id:'door',mesh:'door'}],connections:[{id:'hinge',parent:'frame',child:'door',kind:'revolute',axis:[1,0,0],pivot:[0,20,30],range:[-30,60],control:'opening'}],manufacturing:{mode:'print-in-place'}};
export function build(THREE,p) {
  const root=new THREE.Group();
  const body=new THREE.Mesh(new THREE.BoxGeometry(10,20,30),new THREE.MeshStandardMaterial());
  body.name='door'; body.position.set(p.opening,20,30); root.add(body);
  const frame=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial());
  frame.name='frame'; frame.position.copy(body.position); root.add(frame);
  return root;
}`

it('exports the saved pose as named GLB and round-trips millimetres/Z up', async () => {
  const bytes = await validationMesh({ url: `data:text/javascript,${encodeURIComponent(model)}`, parameters: { opening: 30 } })
  const metadata = mechanismMetadata(validateGlb(new Uint8Array(bytes)))
  expect(metadata.checks).toEqual([])
  expect(metadata.assembly!.connections[0]).toMatchObject({ child: 'door', pivot: [0, 20, 30], range: [-30, 60] })
  expect(validateGlb(new Uint8Array(bytes))).toMatchObject({ asset: { extras: { rumiMotionRanges: [{ key: 'opening', range: [-30, 60], origin: 30 }] } } })
  const imported = await parseGlbModel(bytes)
  try {
    expect(imported.root.getObjectByName('door')).toBeDefined()
    for (const [axis, lower, upper] of [[0, 25, 35], [1, 10, 30], [2, 15, 45]] as const) {
      const values: number[] = []
      for (let index: number = axis; index < imported.positions.length; index += 3) values.push(imported.positions[index]!)
      expect(Math.min(...values)).toBeCloseTo(lower, 3)
      expect(Math.max(...values)).toBeCloseTo(upper, 3)
    }
  } finally { disposeModel(imported.root) }
})

it('exports movement without mechanics as a repairable declaration error', async () => {
  const source = model.replace(/export const assembly = .*;\n/, '')
  const bytes = await validationMesh({ url: `data:text/javascript,${encodeURIComponent(source)}`, parameters: {} })
  expect(mechanismMetadata(validateGlb(new Uint8Array(bytes))).checks[0]!.code).toBe('assembly_description_required')
})

it('keeps static multi-part inventory instead of flattening it to STL', async () => {
  const source = model.replace(/export const assembly = .*;\n/, '').replace(/export const motionControls = .*;\n/, '')
  const bytes = await validationMesh({ url: `data:text/javascript,${encodeURIComponent(source)}`, parameters: {} })
  const manifest = validateGlb(new Uint8Array(bytes))
  expect(manifest.nodes.filter((node: { mesh?: number }) => node.mesh !== undefined)).toHaveLength(2)
  expect(mechanismMetadata(manifest).checks[0]!.code).toBe('assembly_description_required')
})

it('exports the saved-value origin so the absolute control range survives a pose change', async () => {
  const canonical = []
  for (const origin of [0, 30]) {
    const source = model.replace('range:[-30,60]', `range:[${-origin},${90 - origin}]`)
    const bytes = await validationMesh({ url: `data:text/javascript,${encodeURIComponent(source)}`, parameters: { opening: origin } })
    const metadata = mechanismMetadata(validateGlb(new Uint8Array(bytes)))
    expect(metadata.checks).toEqual([])
    const intent = metadata.motionRanges[0]!
    expect(intent.origin).toBe(origin)
    canonical.push(intent.range.map((value: number) => value + intent.origin))
  }
  expect(canonical).toEqual([[0, 90], [0, 90]])
})
