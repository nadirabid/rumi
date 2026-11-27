/** Project builds preserve named parts and expose the geometry actually displayed. */
import { expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { buildModel, disposeModel } from '../viewer/viewport/model.js'
import { build as buildTable } from '../assets/example-model.js'
import { analyzeMesh } from '../viewer/checks.js'

it('builds a named hierarchy and measures part transforms', () => {
  const model = buildModel((T: typeof THREE) => {
    const root = new T.Group()
    const part = new T.Mesh(new T.BoxGeometry(10, 20, 30), new T.MeshStandardMaterial({ color: 'red' }))
    part.name = 'body'
    part.position.set(5, 0, 15)
    root.add(part)
    return root
  })
  expect(model.root.getObjectByName('body')).toBeDefined()
  expect(analyzeMesh(model.positions).dimensions).toEqual({ x: 10, y: 20, z: 30 })
  expect(analyzeMesh(model.positions).bounds.min.z).toBe(0)
  disposeModel(model.root)
})

it('rejects unsupported builds and disposes shared geometry once', () => {
  expect(() => buildModel(() => Promise.resolve(new THREE.Group()))).toThrow('Mesh or Group')
  expect(() => buildModel(() => new THREE.PerspectiveCamera())).toThrow('static Mesh')
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial()
  const disposeGeometry = vi.spyOn(geometry, 'dispose')
  const disposeMaterial = vi.spyOn(material, 'dispose')
  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
  disposeModel(root)
  expect(disposeGeometry).toHaveBeenCalledTimes(1)
  expect(disposeMaterial).toHaveBeenCalledTimes(1)
})


it('records the editable table hierarchy and its measured geometry', () => {
  const model = buildModel(buildTable)
  const report = analyzeMesh(model.positions)
  expect({
    name: model.root.name,
    parts: model.root.children.map(part => part.name),
    dimensions: report.dimensions,
    triangles: report.triangleCount,
  }).toMatchInlineSnapshot(`
    {
      "dimensions": {
        "x": 80,
        "y": 50,
        "z": 40,
      },
      "name": "table",
      "parts": [
        "tabletop",
        "leg--1--1",
        "leg--1-1",
        "leg-1--1",
        "leg-1-1",
      ],
      "triangles": 60,
    }
  `)
  disposeModel(model.root)
})
