/** Selection boundaries and picking must agree on the same displayed triangles. */
import * as THREE from 'three'
import { expect, it } from 'vitest'
import { createSurfaceIndex } from '../viewer/viewport/surfaces.js'
import { cursorCommand } from '../viewer/cursor-commands.js'
import { normalizeHighlight } from '../viewer/highlight.js'

it('joins coplanar triangles, stops at creases, and preserves triangle identity when picking', () => {
  const geometry = new THREE.BoxGeometry(2, 2, 2).toNonIndexed()
  const surfaces = createSurfaceIndex(geometry)
  expect(new Set(surfaces.ids).size).toBe(6)
  const material = new THREE.MeshStandardMaterial()
  const ray = new THREE.Ray(new THREE.Vector3(0.3, 0.2, 5), new THREE.Vector3(0, 0, -1))
  const result = surfaces.pick(ray, material)
  const ordinary = new THREE.Raycaster(ray.origin, ray.direction).intersectObject(new THREE.Mesh(geometry, material))[0]
  expect(result.faceIndex).toBe(ordinary.faceIndex)
  expect(result.point.toArray()).toEqual(ordinary.point.toArray())
  expect(surfaces.boundary.some(value => value === 0)).toBe(true)
  expect(surfaces.boundary.some(value => value === 1)).toBe(true)
  geometry.dispose(); material.dispose()
})

it('separates disconnected coplanar pieces and honors invisible and back-side materials', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 2,0,0, 3,0,0, 2,1,0], 3))
  const surfaces = createSurfaceIndex(geometry)
  expect(surfaces.surface(0)).not.toBe(surfaces.surface(1))
  const material = new THREE.MeshStandardMaterial({ side: THREE.BackSide })
  const ray = new THREE.Ray(new THREE.Vector3(.2, .2, 1), new THREE.Vector3(0, 0, -1))
  expect(surfaces.pick(ray, material)).toBeNull()
  material.side = THREE.DoubleSide
  expect(surfaces.pick(ray, material).faceIndex).toBe(0)
  material.visible = false
  expect(surfaces.pick(ray, material)).toBeNull()
  geometry.dispose(); material.dispose()
})

it('keeps material seams separate even on coplanar triangles', () => {
  const geometry = new THREE.PlaneGeometry(2, 2).toNonIndexed()
  geometry.clearGroups(); geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1)
  const surfaces = createSurfaceIndex(geometry)
  expect(surfaces.surface(0)).not.toBe(surfaces.surface(1))
  geometry.dispose()
})

it('recognizes only short selection requests, never embedded geometry edits or negations', () => {
  expect(cursorCommand('Whole panel.')).toBe('surface')
  expect(cursorCommand('just the edge')).toBe('edge')
  expect(cursorCommand('扩大选区')).toBe('larger')
  for (const phrase of ['make the whole part bigger', 'not the whole panel', 'whole', 'make it larger', 'yes']) {
    expect(cursorCommand(phrase)).toBeNull()
  }
})

it('retains a captured selection for exact agent confirmation and rejects malformed references', () => {
  const selection = { partPath: ['helmet', 'faceplate'], surfaceId: 5, mode: 'surface' }
  expect(normalizeHighlight({ label: 'faceplate', blobs: [], selection }).selection).toEqual(selection)
  expect(() => normalizeHighlight({ label: '', blobs: [], selection: { ...selection, surfaceId: -1 } })).toThrow()
})
