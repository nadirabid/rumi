/** Selection boundaries and picking must agree on the same displayed triangles. */
import * as THREE from 'three'
import { expect, it, vi } from 'vitest'
import { createHighlight } from '../viewer/viewport/highlight.js'
import { createSurfaceIndex } from '../viewer/viewport/surfaces.js'
import { normalizeSelection } from '../viewer/highlight.js'
import { cursorMeshSnapshot } from '../viewer/viewport/cursor-geometry.js'
import { parseStl } from '../viewer/stl.js'
import { createNamedRegionIndex, createNamedRegionVisual } from '../viewer/viewport/named-regions.js'

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

it('selects the nearest visible indexed triangle using its material group and side', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 0, 1, 1,
  ], 3))
  geometry.setIndex([0, 1, 2, 3, 4, 5])
  geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1)
  const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]
  try {
    const surfaces = createSurfaceIndex(geometry)
    const ray = new THREE.Ray(new THREE.Vector3(.2, .2, 2), new THREE.Vector3(0, 0, -1))
    expect(surfaces.pick(ray, materials).faceIndex).toBe(1)
    materials[1]!.visible = false
    expect(surfaces.pick(ray, materials).faceIndex).toBe(0)
    materials[1]!.visible = true
    materials[1]!.side = THREE.BackSide
    expect(surfaces.pick(ray, materials).faceIndex).toBe(0)
    materials[1]!.side = THREE.DoubleSide
    expect(surfaces.pick(ray, materials).faceIndex).toBe(1)
  } finally { geometry.dispose(); materials.forEach(material => material.dispose()) }
})

it('retains a captured selection in a cursor snapshot and rejects malformed references', () => {
  const selection = { partPath: ['helmet', 'faceplate'], surfaceId: 5, mode: 'surface' }
  expect(normalizeSelection(selection)).toEqual(selection)
  expect(() => normalizeSelection({ ...selection, surfaceId: -1 })).toThrow()
})

it('picks and draws the same named faces with viewer placement', () => {
  const geometry = new THREE.PlaneGeometry(2, 2)
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  const viewer = new THREE.Scene(), placement = new THREE.Group(), model = new THREE.Group()
  viewer.add(placement); placement.add(model); model.add(mesh)
  model.userData.rumiCoordinateFrame = true
  mesh.name = 'Bracket'
  mesh.position.set(2, 3, 4)
  placement.position.set(5, 10, 15)
  placement.scale.setScalar(2)
  const firstFace = { id: 'mount-face', name: 'Mount face', location: { kind: 'surface', parts: [{ partPath: ['Bracket'], faceRanges: [[0, 1]] }] } }
  try {
    const index = createNamedRegionIndex(model, placement, [firstFace,
      { ...firstFace, id: 'missing', location: { kind: 'surface', parts: [{ partPath: ['Bracket'], faceRanges: [[5, 6]] }] } }])
    const entry = index.get(firstFace.id)
    expect(index.get('missing')).toBeUndefined()
    const hit = mesh.localToWorld(new THREE.Vector3())
    const ray = new THREE.Ray(hit.clone().add(new THREE.Vector3(0, 0, 30)), new THREE.Vector3(0, 0, -1))
    expect(index.pick({ point: hit, faceIndex: 0, object: mesh }, mesh, ray, 0.001)?.named).toBe(entry)
    expect(index.pick({ point: hit, faceIndex: 1, object: mesh }, mesh, ray, 0.001)).toBeNull()
    const preview = createNamedRegionVisual(entry, viewer, placement, 0x9ab9e1, (node: THREE.Mesh) => node, 0.5)
    try {
      preview.update()
      const child = preview.root.children[0] as THREE.Mesh
      expect([...child.geometry.getAttribute('position').array]).toEqual([-1,1,0, -1,-1,0, 1,1,0])
      expect(child.matrix.equals(mesh.matrixWorld)).toBe(true)
    } finally { preview.dispose() }
  } finally { geometry.dispose(); material.dispose() }
})

it('picks named curves and points in empty space without claiming hidden geometry', () => {
  const placement = new THREE.Group()
  const index = createNamedRegionIndex(placement, placement, [
    { id: 'opening', name: 'Opening', location: { kind: 'curve', points: [[0, 0, 3], [4, 0, 3]] } },
    { id: 'pivot', name: 'Pivot', location: { kind: 'point', point: [2, 2, 0] } },
  ])
  const ray = (x: number, y: number) => new THREE.Ray(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1))
  expect(index.pick(null, null, ray(2, 0), 0.001)?.named.region.id).toBe('opening')
  expect(index.pick(null, null, ray(2, 2), 0.001)?.named.region.id).toBe('pivot')
  expect(index.pick({ point: new THREE.Vector3(2, 0, 5) }, null, ray(2, 0), 0.001)).toBeNull()
})

it('picks progressively narrower named surfaces as they become large enough to target', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0,0,0, 80,0,0, 0,80,0,
    0,0,0, 60,0,0, 0,6,0,
    0,0,0, 50,0,0, 0,1,0,
    50,0,0, 50,1,0, 0,1,0,
  ], 3))
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Shell'
  const placement = new THREE.Group()
  placement.add(mesh)
  const surface = (id: string, start: number, end: number, parentId?: string) => ({
    id, name: id, parentId,
    location: { kind: 'surface', parts: [{ partPath: ['Shell'], faceRanges: [[start, end]] }] },
  })
  try {
    const index = createNamedRegionIndex(placement, placement, [
      surface('seam', 2, 4, 'rim'),
      surface('seam-face', 3, 4, 'seam'),
      surface('wall', 0, 4),
      surface('rim', 1, 4, 'wall'),
      surface('bad-detail', 0, 1, 'rim'),
    ])
    const pick = (distance: number, faceIndex = 2) => {
      const point = new THREE.Vector3(faceIndex === 3 ? 49.5 : 0.5, 0.5, 0)
      const ray = new THREE.Ray(point.clone().add(new THREE.Vector3(0, 0, distance)), new THREE.Vector3(0, 0, -1))
      return index.pick({ point, faceIndex, object: mesh }, mesh, ray, 0.001)?.named.region.id
    }
    expect(index.get('bad-detail')).toBeUndefined()
    expect(index.get('seam')?.region.id).toBe('seam')
    expect(pick(250)).toBe('wall')
    expect(pick(100)).toBe('rim')
    expect(pick(20)).toBe('seam')
    expect(pick(20, 0)).toBe('wall')
    expect(pick(40)).toBe('rim')
    expect([40, 25, 20, 25, 40].map(distance => pick(distance, 3))).toEqual([
      'rim', 'seam', 'seam-face', 'seam', 'rim',
    ])
    mesh.scale.y = 2
    mesh.updateWorldMatrix(true, false)
    expect(pick(40)).toBe('seam')
  } finally { geometry.dispose(); material.dispose() }
})

it('exports the exact connected surface and the whole part in their saved coordinates', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0,
    0, 0, 1, 4, 0, 1, 4, 4, 1,
  ], 3))
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6])
  const material = new THREE.MeshBasicMaterial()
  const saved = new THREE.Mesh(geometry, material)
  saved.position.set(4, 5, 6)
  saved.scale.x = -1
  const placement = new THREE.Group()
  placement.position.set(10, 20, 30)
  placement.rotation.set(-0.3, 1.21, 0.048)
  placement.scale.setScalar(2)
  placement.add(saved)
  const posed = new THREE.Mesh(geometry.toNonIndexed(), material)
  posed.position.set(50, 60, 70)
  posed.updateMatrixWorld(true)
  try {
    const spatial = createSurfaceIndex(posed.geometry)
    posed.geometry.userData.rumiSurfaceIndex = spatial
    const hit = { object: posed, faceIndex: 0, surfaceId: spatial.surface(0), point: new THREE.Vector3(52, 61, 70), radius: 0.1 }
    const surface = cursorMeshSnapshot(hit, saved, placement, 'surface')
    expect(surface).toHaveProperty('meshStl')
    const selected = parseStl(Buffer.from(surface.meshStl!, 'base64'))
    expect([...selected]).toEqual([
      4, 5, 6, 0, 9, 6, 0, 5, 6,
      4, 5, 6, 4, 9, 6, 0, 9, 6,
    ])
    const part = cursorMeshSnapshot(hit, saved, placement, 'part')
    expect([...parseStl(Buffer.from(part.meshStl!, 'base64'))]).toEqual([
      ...selected, 4, 5, 7, 0, 9, 7, 0, 5, 7,
    ])
  } finally { geometry.dispose(); posed.geometry.dispose(); material.dispose() }
})

it('exports patch faces across shared edges and restricts edge mode to nearby boundaries', () => {
  const geometry = new THREE.PlaneGeometry(4, 4)
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  const placement = new THREE.Group()
  placement.add(mesh)
  try {
    const spatial = createSurfaceIndex(geometry)
    const hit = { object: mesh, faceIndex: 0, surfaceId: spatial.surface(0), point: new THREE.Vector3(), radius: 0.2 }
    const patch = cursorMeshSnapshot(hit, mesh, placement, 'patch')
    expect(parseStl(Buffer.from(patch.meshStl!, 'base64'))).toHaveLength(18)
    expect(cursorMeshSnapshot(hit, mesh, placement, 'edge')).toEqual({ meshUnavailable: 'empty_selection' })
    hit.point.set(-1.9, 0, 0)
    const edge = cursorMeshSnapshot(hit, mesh, placement, 'edge')
    expect(parseStl(Buffer.from(edge.meshStl!, 'base64'))).toHaveLength(9)
  } finally { geometry.dispose(); material.dispose() }
})

it.each(['curved', 'flat', 'shuffled'])('matches native picking across a subdivided %s mesh', (kind) => {
  const geometry = kind === 'flat' ? new THREE.PlaneGeometry(10, 10, 32, 32) : new THREE.SphereGeometry(5, 64, 32)
  if (kind === 'shuffled') {
    const original = geometry.index!.array.slice(), faces = original.length / 3
    for (let face = 0; face < faces; face++) {
      const source = (face * 193) % faces
      for (let corner = 0; corner < 3; corner++) geometry.index!.setX(face * 3 + corner, original[source * 3 + corner]!)
    }
  }
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

it('keeps a non-manifold edge open on every participating triangle', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    1, 0, 0, 0, 0, 0, 0, -1, 0,
    0, 0, 0, 1, 0, 0, 1, 1, 0,
  ], 3))
  try {
    const surfaces = createSurfaceIndex(geometry)
    expect(new Set(surfaces.ids).size).toBe(3)
    for (let face = 0; face < 3; face++) {
      for (let vertex = 0; vertex < 3; vertex++) expect(surfaces.boundary[face * 9 + vertex * 3 + 2]).toBe(1)
    }
  } finally { geometry.dispose() }
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
