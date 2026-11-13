/** Selection boundaries and picking must agree on the same displayed triangles. */
import * as THREE from 'three'
import { expect, it, vi } from 'vitest'
import { createHighlight } from '../viewer/viewport/highlight.js'
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

it.each(['curved', 'flat'])('matches native picking across a subdivided %s mesh', (kind) => {
  const geometry = kind === 'curved' ? new THREE.SphereGeometry(5, 64, 32) : new THREE.PlaneGeometry(10, 10, 32, 32)
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  const surfaces = createSurfaceIndex(geometry)
  try {
    for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
      material.side = side
      for (let i = 0; i < 32; i++) {
        const ray = new THREE.Raycaster(new THREE.Vector3(Math.sin(i * 1.37) * 7, Math.cos(i * .81) * 7, 12), new THREE.Vector3(0, 0, -1))
        const expected = ray.intersectObject(mesh)[0]
        const actual = surfaces.pick(ray.ray, material)
        expect(Boolean(actual)).toBe(Boolean(expected))
        if (expected) {
          expect(actual.faceIndex).toBe(expected.faceIndex)
          expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-9)
        }
      }
    }
  } finally { geometry.dispose(); material.dispose() }
})

it.each(['suspended', 'resumed'])('retains prepared highlight resources across suspension and releases from %s state', (state) => {
  const geometry = new THREE.BoxGeometry(2, 2, 2), material = new THREE.MeshStandardMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  const overlay = createHighlight(mesh, { blobs: [] })
  const displayGeometry = mesh.geometry, displayMaterial = mesh.material
  const spatial = displayGeometry.userData.rumiSurfaceIndex
  const geometryDisposed = vi.spyOn(displayGeometry, 'dispose'), materialDisposed = vi.spyOn(displayMaterial, 'dispose')
  try {
    overlay.suspend(); overlay.suspend()
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.material).toBe(material)
    expect(geometryDisposed).not.toHaveBeenCalled()
    expect(materialDisposed).not.toHaveBeenCalled()
    overlay.resume(); overlay.resume()
    expect(mesh.geometry).toBe(displayGeometry)
    expect(mesh.material).toBe(displayMaterial)
    expect(mesh.geometry.userData.rumiSurfaceIndex).toBe(spatial)
    if (state === 'suspended') overlay.suspend()
    overlay.dispose(); overlay.dispose(); overlay.resume()
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.material).toBe(material)
    expect(geometryDisposed).toHaveBeenCalledTimes(1)
    expect(materialDisposed).toHaveBeenCalledTimes(1)
  } finally { overlay.dispose(); geometry.dispose(); material.dispose() }
})
