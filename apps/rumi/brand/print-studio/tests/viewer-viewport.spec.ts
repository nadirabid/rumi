/** The viewport reconciles a scene view into real three objects and owns every resource it makes. */
import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createViewport } from '../viewer/viewport/index.js'
import { createRegionPicker } from '../viewer/viewport/region-marker.js'
import { robotUsd } from './fixtures/robot-usd.js'
import { generateStl } from '../viewer/generation/export.js'

const state = vi.hoisted(() => ({ renderer: null, controls: null, resize: null }))
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    PMREMGenerator: class {
      fromScene() { return { texture: new actual.Texture(), dispose: vi.fn() } }
      dispose() {}
    },
    WebGLRenderer: class {
      constructor() {
        this.domElement = {
          width: 0, height: 0,
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
          setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn(),
        }
        this.domElement.toDataURL = vi.fn(() => 'data:image/png;base64,cG5n')
        this.ratio = 1
        this.setPixelRatio = vi.fn((value) => { this.ratio = value })
        this.getPixelRatio = () => this.ratio
        this.getSize = target => target.set(this.domElement.width, this.domElement.height)
        this.setSize = (width: number, height: number) => { this.domElement.width = width; this.domElement.height = height }
        this.render = vi.fn()
        this.dispose = vi.fn()
        this.forceContextLoss = vi.fn()
        state.renderer = this
      }
    },
  }
})
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    constructor() {
      this.target = new THREE.Vector3()
      vi.spyOn(this.target, 'copy')
      this.dispose = vi.fn()
      state.controls = this
    }
    update() {}
    addEventListener = vi.fn()
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  state.renderer = null
  state.controls = null
})

function container() {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }), devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#888888' }))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { this.disconnect = vi.fn(); state.resize = callback }
    observe() {}
  })
  return { appendChild: vi.fn(), getBoundingClientRect: () => ({ width: 400, height: 300 }) }
}

async function boxBytes(width: number, height: number, depth: number, name = 'design') {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed()
  const bytes = await generateStl(geometry.getAttribute('position').array)
  geometry.dispose()
  const text = new TextDecoder().decode(bytes).replaceAll('Imported_mesh', name)
  return new TextEncoder().encode(text).buffer
}
async function boxUrl(width: number, height: number, depth: number, name = 'design') {
  return 'data:application/octet-stream;base64,' + Buffer.from(await boxBytes(width, height, depth, name)).toString('base64')
}

const positions = () => new Float32Array([0, 0, 0, 12, 0, 0, 0, 12, 0])
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const object = (id: string, datablockId: string = 'd1', matrix: number[] = identity) => ({ id, datablockId, positions: positions(), matrix, blocked: false })
const meshes = () => {
  const result: THREE.Mesh[] = []
  state.renderer.render.mock.calls.at(-1)[0].traverse((node: THREE.Object3D) => { if (node instanceof THREE.Mesh) result.push(node) })
  return result
}
const rendered = () => state.renderer.render.mock.calls.at(-1)[0]

it('draws one object per scene entry and applies the matrix the host measured with', async () => {
  const viewport = createViewport(container(), vi.fn())
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
  await viewport.apply({ volume: null, objects: [object('o1', 'd1', matrix)] })
  const [mesh] = meshes()
  expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([5, 6, 7])
  expect(mesh.geometry.getAttribute('position').count).toBe(3)
  viewport.dispose()
})

it('centers the dotted shell after a pan and keeps the camera and mesh inside', async () => {
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: null, objects: [object('mesh')] })
  state.resize()
  const grid = rendered().getObjectByName('Rumi sphere grid')
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const center = grid.getWorldPosition(new THREE.Vector3())
  const distance = camera.position.distanceTo(center)
  expect(grid.isPoints).toBe(true)
  expect(center.equals(state.controls.target)).toBe(true)
  expect(grid.worldToLocal(camera.position.clone()).length()).toBeLessThan(1)

  state.renderer.render.mockImplementation((_scene, current) => expect(current.layers.test(grid.layers)).toBe(true))
  camera.position.copy(center).add(new THREE.Vector3(distance * 4, 0, 0))
  camera.lookAt(state.controls.target)
  viewport.setHighlightVisible(true)
  expect(grid.worldToLocal(camera.position.clone()).length()).toBeLessThan(1)
  expect(camera.layers.test(grid.layers)).toBe(false)

  const pan = new THREE.Vector3(2, -1, 3).multiplyScalar(distance)
  state.controls.target.add(pan)
  camera.position.add(pan)
  camera.lookAt(state.controls.target)
  camera.updateMatrixWorld()
  viewport.setHighlightVisible(true)
  const projected = grid.getWorldPosition(new THREE.Vector3()).project(camera)
  expect(projected.x).toBeCloseTo(0)
  expect(projected.y).toBeCloseTo(0)
  function expectMeshInside() {
    const mesh = meshes()[0], vertices = mesh.geometry.getAttribute('position')
    for (let i = 0; i < vertices.count; i++) {
      const worldPoint = mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(vertices, i))
      expect(grid.worldToLocal(worldPoint).length()).toBeLessThan(1)
    }
  }
  expectMeshInside()

  const placement = [...identity]
  placement[12] = distance * 12
  await viewport.apply({ volume: null, objects: [object('mesh', 'd1', placement)] })
  expect(grid.getWorldPosition(new THREE.Vector3()).equals(state.controls.target)).toBe(true)
  expectMeshInside()
  viewport.dispose()
})

it('keeps the long axis along the view while orbiting moves the dots across the shell', async () => {
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: null, objects: [object('mesh')] })
  state.resize()
  const grid = rendered().getObjectByName('Rumi sphere grid')
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const { target, addEventListener } = state.controls
  const change = addEventListener.mock.calls.find(([name]) => name === 'change')[1]
  const distance = camera.position.distanceTo(target)

  function orbit(direction: THREE.Vector3) {
    camera.position.copy(target).add(direction.setLength(distance))
    camera.lookAt(target)
    camera.updateMatrixWorld()
    change()
    grid.updateWorldMatrix(true, false)
    const viewFromGrid = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, grid.matrixWorld)
    const right = new THREE.Vector3(), up = new THREE.Vector3(), depth = new THREE.Vector3()
    viewFromGrid.clone().transpose().extractBasis(right, up, depth)
    expect(right.length()).toBeCloseTo(up.length())
    expect(depth.length() / right.length()).toBeCloseTo(5)
    right.normalize()
    up.normalize()
    depth.normalize()
    expect(right.dot(up)).toBeCloseTo(0)
    expect(right.dot(depth)).toBeCloseTo(0)
    expect(up.dot(depth)).toBeCloseTo(0)
    return viewFromGrid
  }

  const start = orbit(new THREE.Vector3(0, -1, 0.25))
  const dots = grid.geometry.getAttribute('position')
  const point = new THREE.Vector3(), dot = new THREE.Vector3()
  let farthest = Infinity
  for (let i = 0; i < dots.count; i++) {
    const z = point.fromBufferAttribute(dots, i).applyMatrix4(start).z
    if (z < farthest) { farthest = z; dot.fromBufferAttribute(dots, i) }
  }
  const before = grid.localToWorld(dot.clone()).project(camera)
  expect(Math.hypot(before.x, before.y)).toBeLessThan(0.1)
  orbit(new THREE.Vector3(0.3, -1, 0.4))
  const after = grid.localToWorld(dot.clone()).project(camera)
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.1)
  expect(Math.max(Math.abs(after.x), Math.abs(after.y))).toBeLessThan(1)
  viewport.dispose()
})

it('shares one geometry between placements of the same datablock and disposes it with the last one', async () => {
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: null, objects: [object('o1'), object('o2')] })
  const [first, second] = meshes()
  expect(first.geometry.getAttribute('position').array).toEqual(second.geometry.getAttribute('position').array)
  const generationDisposals = dispose.mock.calls.length
  await viewport.apply({ volume: null, objects: [object('o2')] })
  expect(meshes()).toHaveLength(1)
  expect(dispose).toHaveBeenCalledTimes(generationDisposals + 1)
  await viewport.apply({ volume: null, objects: [] })
  expect(dispose).toHaveBeenCalledTimes(generationDisposals + 3)
  viewport.dispose()
})

it('draws the plate, grid, and envelope for a print volume and replaces them when it changes', async () => {
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: { x: 300, y: 320, z: 320 }, objects: [object('o1')] })
  expect(rendered().children.filter(child => child.isLineSegments)).toHaveLength(2)
  expect(meshes()).toHaveLength(2)
  const generationDisposals = dispose.mock.calls.length
  await viewport.apply({ volume: { x: 200, y: 200, z: 200 }, objects: [object('o1')] })
  expect(dispose).toHaveBeenCalledTimes(generationDisposals + 3)
  expect(rendered().children.filter(child => child.isLineSegments)).toHaveLength(2)
  viewport.dispose()
})

it('keeps the camera across scene updates and frames once', async () => {
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: null, objects: [object('o1')] })
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  await viewport.apply({ volume: null, objects: [object('o1', 'd1', [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 40, 0, 0, 1])] })
  expect(camera.position.distanceTo(position)).toBe(0)
  viewport.dispose()
})

it('frames the scene once the canvas has a size, using the field that actually fits', async () => {
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: null, objects: [object('o1')] })
  state.resize?.()
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  expect(camera.position.length()).toBeGreaterThan(0)
  expect(Number.isFinite(camera.position.x)).toBe(true)
  expect(state.controls.target.copy).toHaveBeenCalledTimes(1)
  viewport.dispose()
})

it('releases the renderer, the controls, and every resource once', async () => {
  const viewport = createViewport(container(), vi.fn())
  await viewport.apply({ volume: { x: 100, y: 100, z: 100 }, objects: [object('o1')] })
  viewport.dispose()
  viewport.dispose()
  expect(state.controls.dispose).toHaveBeenCalledOnce()
  expect(state.renderer.dispose).toHaveBeenCalledOnce()
  expect(state.renderer.forceContextLoss).toHaveBeenCalledOnce()
  expect(state.renderer.domElement.remove).toHaveBeenCalledOnce()
  expect(state.renderer.domElement.removeEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function))
})

it('reloads source models without resetting the camera and keeps the last build on failure', async () => {
  const viewport = createViewport(container(), vi.fn())
  const spec = { format: 'usd', url: await boxUrl(10, 2, 3), transform: { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } } }
  const report = await viewport.applyDesign(spec, null)
  expect(report.dimensions.x).toBe(10)
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  await viewport.applyDesign({ ...spec, url: await boxUrl(20, 2, 3) }, null)
  expect(camera.position.equals(position)).toBe(true)
  const scene = rendered()
  expect(new THREE.Box3().setFromObject(scene.getObjectByName('design')).getSize(new THREE.Vector3()).x).toBeCloseTo(20, 4)
  await expect(viewport.applyDesign({ ...spec, url: 'data:application/octet-stream;base64,YmFk' }, null)).rejects.toThrow('USD')
  expect(new THREE.Box3().setFromObject(scene.getObjectByName('design')).getSize(new THREE.Vector3()).x).toBeCloseTo(20, 4)
  viewport.dispose()
})

it('discards a USD load that completes after the viewport is disposed', async () => {
  const response = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
  const bytes = await boxBytes(1, 2, 3)
  vi.stubGlobal('fetch', vi.fn(() => { entered.resolve(); return response.promise }))
  const viewport = createViewport(container(), vi.fn())
  const loading = viewport.applyDesign({ format: 'usd', url: '/late.usda', transform: {} }, null)
  await entered.promise
  const disposed = viewport.dispose()
  response.resolve(new Response(bytes))
  expect(await loading).toBeNull()
  await disposed
})

it('keeps the latest USD revision when an older fetch completes later', async () => {
  const older = Promise.withResolvers<Response>(), entered = Promise.withResolvers<void>()
  const oldBytes = await boxBytes(1, 2, 3), newBytes = await boxBytes(50, 2, 3, 'newest')
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (url === '/older.usda') { entered.resolve(); return older.promise }
    return Promise.resolve(new Response(newBytes))
  }))
  const viewport = createViewport(container(), vi.fn())
  const first = viewport.applyDesign({ format: 'usd', url: '/older.usda', transform: {} }, null)
  await entered.promise
  const report = await viewport.applyDesign({ format: 'usd', url: '/newer.usda', transform: {} }, null)
  expect(report.dimensions.x).toBe(50)
  older.resolve(new Response(oldBytes))
  expect(await first).toBeNull()
  expect(new THREE.Box3().setFromObject(rendered().getObjectByName('newest')).getSize(new THREE.Vector3()).x).toBeCloseTo(50, 4)
  await viewport.dispose()
})

it('frames the current design before applying a requested camera angle', async () => {
  const viewport = createViewport(container(), vi.fn())
  const url = await boxUrl(100, 20, 30)
  await viewport.applyDesign({ format: 'usd', url, transform: {}, camera: { id: 'front', azimuth: 0, elevation: 0 } }, null)
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  expect(camera.position.x).toBeCloseTo(0)
  expect(camera.position.y).toBeLessThan(-100)
  expect(camera.position.z).toBeCloseTo(15)
  viewport.dispose()
})


it('captures loaded geometry at cover size and restores the viewport even when encoding fails', async () => {
  const viewport = createViewport(container(), vi.fn())
  expect(viewport.thumbnail()).toBeNull()
  await viewport.apply({ volume: { x: 200, y: 200, z: 200 }, objects: [object('cover')] })
  state.resize()
  const scene = rendered()
  const grid = scene.getObjectByName('Rumi sphere grid')
  const geometry = meshes()[0].geometry
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  state.renderer.domElement.toDataURL.mockImplementation(() => {
    expect(state.renderer.domElement.width).toBe(1440)
    expect(state.renderer.domElement.height).toBe(960)
    expect(scene.children.filter(node => node.isLineSegments).every(node => !node.visible)).toBe(true)
    const coverCamera = state.renderer.render.mock.calls.at(-1)[1]
    expect(coverCamera.isOrthographicCamera).toBe(true)
    expect(coverCamera.layers.test(grid.layers)).toBe(false)
    expect(coverCamera.right / coverCamera.top).toBeCloseTo(1.5)
    expect(camera.children.find((node: THREE.Object3D) => node instanceof THREE.DirectionalLight)?.visible).toBe(false)
    throw new Error('encoding failed')
  })
  expect(() => viewport.thumbnail()).toThrow('encoding failed')
  expect(state.renderer.domElement.width).toBe(400)
  expect(state.renderer.domElement.height).toBe(300)
  expect(scene.children.every(node => node.visible)).toBe(true)
  expect(meshes()[0].geometry).toBe(geometry)
  expect(camera.position.equals(position)).toBe(true)
  expect(camera.children.find((node: THREE.Object3D) => node instanceof THREE.DirectionalLight)?.visible).toBe(true)
  viewport.dispose()
  expect(viewport.thumbnail()).toBeNull()
})

it('owns a temporary overlay separately from design geometry and excludes it from covers', async () => {
  const viewport = createViewport(container(), vi.fn())
  const url = await boxUrl(10, 20, 30, 'highlight-subject')
  const spec = { format: 'usd', url, transform: {}, highlight: { id: 'region-1', label: 'Top', positions: new Float32Array([
    -5, -10, 15, -2, -10, 15, -5, -8, 15, 2, 8, 15, 5, 8, 15, 5, 10, 15,
  ]) } }
  const report = await viewport.applyDesign(spec, null)
  const design = rendered().getObjectByName('highlight-subject')
  const overlay = rendered().getObjectByName('Rumi highlight overlay')
  expect(overlay.geometry.getAttribute('position').array).toEqual(spec.highlight.positions)
  expect(overlay.material.depthTest).toBe(true)
  expect(overlay.material.polygonOffset).toBe(true)
  const disposed = vi.spyOn(overlay.geometry, 'dispose')
  const copy = design.geometry
  const material = design.material
  expect(report.dimensions).toEqual({ x: 10, y: 20, z: 30 })
  expect(copy.getAttribute('rumiBarycentric')).toBeDefined()
  expect(viewport.renderedHighlight()).toBe('region-1')
  const shader = { uniforms: { rumiReveal: { value: 1 } }, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
  material.onBeforeCompile(shader, state.renderer)
  expect(shader.fragmentShader).toContain('vec3(0.18, 0.40, 0.37)')
  viewport.setHighlightVisible(false)
  expect(viewport.renderedHighlight()).toBeNull()
  expect(overlay.visible).toBe(false)
  expect(shader.uniforms.rumiReveal.value).toBe(0)
  viewport.setHighlightVisible(true)
  const visibility: number[] = []
  state.renderer.render.mockImplementation(() => visibility.push(shader.uniforms.rumiReveal.value))
  viewport.thumbnail()
  expect(visibility).toEqual([0, 1])
  state.renderer.render.mockImplementation(() => {})
  const disposeGeometry = vi.spyOn(copy, 'dispose')
  const disposeMaterial = vi.spyOn(material, 'dispose')
  await viewport.applyDesign({ ...spec, highlight: null }, null)
  expect(rendered().getObjectByName('Rumi highlight overlay')).toBeUndefined()
  expect(disposed).toHaveBeenCalledOnce()
  expect(disposeGeometry).not.toHaveBeenCalled()
  expect(disposeMaterial).not.toHaveBeenCalled()
  expect(design.geometry).toBe(copy)
  expect(design.material).toBe(material)
  expect(design.geometry.getAttribute('rumiBarycentric')).toBeDefined()
  const hoverOnly = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
  design.material.onBeforeCompile(hoverOnly, state.renderer)
  expect(hoverOnly.uniforms.rumiHover.value.w).toBe(0)
  expect(design.material).toBe(material)
  viewport.dispose()
})

it('coalesces hover, follows placed surfaces, clears on leave, and cancels work on disposal', async () => {
  const { createHover } = await import('../viewer/viewport/hover.js')
  const listeners = new Map<string, (event?: object) => void>()
  const frames = new Map<number, () => void>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', new EventTarget())
  const canvas = {
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
  }
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial())
  const overlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  overlay.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 1, 1, -1, 1, 0, 1, 1], 3))
  const namedRegion = createRegionPicker(overlay)
  const presented = vi.fn((hit, ray, pinned) => Boolean(namedRegion(hit, ray)) && (pinned ? 'pinned' : 'hovered'))
  const render = vi.fn()
  const hover = createHover(canvas, camera, () => [mesh], render, undefined, undefined, presented)
  const flush = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()) }
  try {
    listeners.get('pointermove')!({ clientX: 0, clientY: 0, pointerType: 'mouse' })
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    expect(frames.size).toBe(1)
    flush()
    expect(render).toHaveBeenCalledOnce()
    expect(hover.sphere.value.z).toBeCloseTo(1)
    expect(hover.sphere.value.w).toBeGreaterThan(0)
    expect(presented.mock.results.at(-1)?.value).toBe('hovered')
    const click = (clientX: number) => {
      const pointer = { clientX, clientY: 200, pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1 }
      listeners.get('pointerdown')!(pointer)
      listeners.get('pointerup')!(pointer)
    }
    click(200)
    listeners.get('pointerleave')!()
    expect(presented.mock.results.at(-1)?.value).toBe('pinned')
    click(250)
    expect(hover.sphere.value.w).toBeGreaterThan(0)
    expect(presented.mock.results.at(-1)?.value).toBe(false)
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    flush()
    mesh.position.z = 2
    hover.invalidate()
    flush()
    expect(hover.sphere.value.z).toBeCloseTo(3)
    expect(presented.mock.results.at(-1)?.value).toBe(false)
    mesh.visible = false
    hover.invalidate()
    flush()
    expect(hover.sphere.value.w).toBe(0)
    mesh.visible = true
    listeners.get('pointermove')!({ clientX: -5, clientY: 200, pointerType: 'mouse' })
    flush()
    expect(hover.sphere.value.w).toBe(0)
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    flush()
    listeners.get('pointerleave')!()
    expect(hover.sphere.value.w).toBe(0)
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'touch' })
    expect(frames.size).toBe(0)
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    hover.dispose()
    expect(frames.size).toBe(0)
    expect(listeners.size).toBe(0)
  } finally {
    hover.dispose()
    mesh.geometry.dispose()
    mesh.material.dispose()
    overlay.geometry.dispose()
    overlay.material.dispose()
  }
})

it('captures the same displayed Gaussian in model coordinates and restores screenshot sizing', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    await viewport.apply({ revision: 7, volume: null, objects: [] })
    const url = await boxUrl(10, 10, 10, 'faceplate')
    const transform = { scale: 2, rotate: { x: 0, y: 0, z: 30 }, position: { x: 4, y: 8, z: 0 } }
    await viewport.applyDesign({ format: 'usd', path: '/model.usda', revision: 3, url, transform }, null)
    state.resize()
    const camera = state.renderer.render.mock.calls.at(-1)[1]
    camera.lookAt(state.controls.target)
    const move = state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === 'pointermove')[1]
    move({ clientX: 200, clientY: 150, pointerType: 'mouse' })
    state.renderer.domElement.toDataURL.mockImplementationOnce(() => {
      expect(state.renderer.domElement.width).toBe(800)
      expect(state.renderer.domElement.height).toBe(600)
      expect(camera.layers.test(rendered().getObjectByName('Rumi sphere grid').layers)).toBe(false)
      return 'data:image/png;base64,cG5n'
    })
    const capture = viewport.captureCursor()
    expect(capture.status).toBe('captured')
    expect(capture.identity).toEqual({ sceneRevision: 7, design: { path: '/model.usda', revision: 3, url, transform } })
    expect(capture.region.partPath).toEqual(['Model', 'faceplate'])
    expect(capture.region.objectId).toBeNull()
    expect(capture.region.modelLocalBlob.radii[0]).toBeCloseTo(capture.region.worldRadius / 2)
    let root = rendered().getObjectByName('faceplate')
    while (!root.userData.rumiCoordinateFrame) root = root.parent
    while (root.parent?.userData.rumiCoordinateFrame) root = root.parent
    root = root.parent
    const world = new THREE.Vector3(...capture.region.modelLocalBlob.center).applyMatrix4(root.matrixWorld)
    expect(world.distanceTo(new THREE.Vector3(...capture.region.worldPoint))).toBeLessThan(1e-6)
    expect(capture.image).toBe('data:image/png;base64,cG5n')
    expect(state.renderer.domElement.width).toBe(400)
    expect(state.renderer.domElement.height).toBe(300)
    state.renderer.domElement.toDataURL.mockReturnValueOnce('a'.repeat(3_000_001)).mockImplementationOnce(() => {
      expect(state.renderer.domElement.width).toBe(640)
      expect(state.renderer.domElement.height).toBe(480)
      return 'data:image/png;base64,cG5n'
    })
    expect(viewport.captureCursor()).toMatchObject({ status: 'captured', image: 'data:image/png;base64,cG5n' })
    expect(state.renderer.domElement.width).toBe(400)
    expect(state.renderer.domElement.height).toBe(300)
    const leave = state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === 'pointerleave')[1]
    leave()
    expect(viewport.captureCursor()).toEqual({ status: 'no_hit' })
  } finally { viewport.dispose() }
})

it('reports unresolved surface IDs for their map and still draws matching selections', async () => {
  const viewport = createViewport(container(), vi.fn())
  try {
    const spec = { format: 'usd', url: await boxUrl(10, 10, 10), transform: {} }
    const valid = { id: 'side', name: 'Side', location: { kind: 'surface', parts: [{ partPath: ['Model', 'design'], faceRanges: [[0, 2]] }] } }
    const invalid = { ...valid, id: 'cap', location: { kind: 'surface', parts: [{ partPath: ['Model', 'design'], surfaceIds: [9000] }] } }
    await viewport.applyDesign({ ...spec, regionMap: { key: 'one', regions: [valid, invalid] },
      highlight: { id: 'show-side', regionId: 'side', regionMapKey: 'one' } }, null)
    expect(viewport.regionResolution()).toEqual({ key: 'one', unresolvedIds: ['cap'] })
    expect(viewport.renderedHighlight()).toBe('show-side')
    await viewport.applyDesign({ ...spec, regionMap: { key: 'two', regions: [valid] } }, null)
    expect(viewport.regionResolution()).toEqual({ key: 'two', unresolvedIds: [] })
  } finally { viewport.dispose() }
})

it('changes a named hover on camera zoom while retaining a pinned selection', async () => {
  const onRegionMarker = vi.fn()
  const viewport = createViewport(container(), vi.fn(), undefined, undefined, undefined, onRegionMarker)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    const whole = { id: 'shell', name: 'Shell', location: { kind: 'surface', parts: [{ partPath: ['Model', 'design'] }] } }
    const panel = { id: 'panel', name: 'Panel', parentId: 'shell',
      location: { kind: 'surface', parts: [{ partPath: ['Model', 'design'], faceRanges: [[8, 10]] }] } }
    const spec = {
      format: 'usd', path: '/model.usda', revision: 1, url: await boxUrl(10, 10, 10), transform: {},
      regionMap: { key: 'nested', regions: [whole, panel] },
    }
    await viewport.applyDesign(spec, null)
    state.resize()
    viewport.setCursorMode('named')
    const mesh = rendered().getObjectByName('design')
    const target = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()).add(new THREE.Vector3(1, 1, 0))
    const camera = state.renderer.render.mock.calls.at(-1)[1]
    const cameraChanged = state.controls.addEventListener.mock.calls.find(([name]) => name === 'change')[1]
    const listener = name => state.renderer.domElement.addEventListener.mock.calls.find(([event]) => event === name)[1]
    const pointAt = (distance: number) => {
      camera.position.copy(target).add(new THREE.Vector3(0, 0, distance))
      camera.up.set(0, 1, 0)
      camera.lookAt(target)
    }
    const flushFrame = () => requestAnimationFrame.mock.lastCall[0]()
    const pointer = { clientX: 200, clientY: 150, pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1 }
    pointAt(350)
    listener('pointermove')(pointer)
    flushFrame()
    expect(onRegionMarker.mock.lastCall[0].name).toBe('Shell')
    pointAt(35)
    cameraChanged()
    flushFrame()
    expect(onRegionMarker.mock.lastCall[0].name).toBe('Panel')
    listener('pointerdown')(pointer)
    listener('pointerup')(pointer)
    pointAt(350)
    cameraChanged()
    expect(viewport.captureCursor().namedRegion.id).toBe('panel')
    listener('pointerdown')(pointer)
    listener('pointerup')(pointer)
    expect(onRegionMarker.mock.lastCall[0].name).toBe('Shell')
    await viewport.applyDesign({ ...spec, highlight: { id: 'show-panel', regionId: panel.id, regionMapKey: 'nested' } }, null)
    expect(viewport.renderedHighlight()).toBe('show-panel')
  } finally { viewport.dispose() }
})

it('pins each cursor mode at the click and resumes hover after the next click', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    const spec = { format: 'usd', path: '/model.usda', revision: 1, url: await boxUrl(10, 10, 10), transform: {} }
    await viewport.applyDesign(spec, null)
    state.resize()
    const camera = state.renderer.render.mock.calls.at(-1)[1]
    camera.lookAt(state.controls.target)
    const listener = (type: string) => state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === type)[1]
    const pointer = { pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 200, clientY: 150 }
    const click = (event = pointer) => {
      listener('pointerdown')(event)
      listener('pointerup')(event)
    }
    const blank = { ...pointer, clientX: 0, clientY: 0 }
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
    meshes()[0].material.onBeforeCompile(shader, state.renderer)

    for (const [index, mode] of ['patch', 'surface', 'part', 'edge'].entries()) {
      viewport.setCursorMode(mode)
      listener('pointermove')(blank)
      click()
      const pinned = viewport.captureCursor()
      expect(pinned.status).toBe('captured')
      expect(pinned.region.selection.mode).toBe(mode)
      expect(shader.uniforms.rumiCursorMode.value).toBe(index)
      const scope = shader.uniforms.rumiHover.value.toArray()
      expect(scope.slice(0, 3)).toEqual(pinned.region.worldPoint)
      listener('pointerdown')(pointer)
      listener('pointermove')(blank)
      listener('pointerup')(pointer)
      listener('pointerleave')()
      vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'blur')![1](new Event('blur'))
      expect(viewport.captureCursor().region.worldPoint).toEqual(pinned.region.worldPoint)
      expect(shader.uniforms.rumiHover.value.toArray()).toEqual(scope)
      click(blank)
      expect(viewport.captureCursor()).toEqual({ status: 'no_hit' })
      listener('pointermove')(pointer)
      expect(viewport.captureCursor().status).toBe('captured')
    }

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    expect(viewport.captureCursor()).toEqual({ status: 'viewer_unavailable', reason: 'viewer_hidden' })
    Object.defineProperty(document, 'hidden', { value: false })
    listener('pointermove')(pointer)
    click()
    const pinned = viewport.captureCursor()
    viewport.setCursorMode('part')
    expect(viewport.captureCursor().region).toMatchObject({ worldPoint: pinned.region.worldPoint, selection: { mode: 'part' } })
    expect(shader.uniforms.rumiHover.value.toArray().slice(0, 3)).toEqual(pinned.region.worldPoint)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    expect(viewport.captureCursor()).toMatchObject({
      status: 'captured', region: { worldPoint: pinned.region.worldPoint }, image: 'data:image/png;base64,cG5n',
    })
    await viewport.applyDesign({ ...spec, transform: { scale: 2 } }, null)
    expect(viewport.captureCursor()).toEqual({ status: 'viewer_unavailable', reason: 'viewer_hidden' })
    Object.defineProperty(document, 'hidden', { value: false })
    expect(viewport.captureCursor()).toEqual({ status: 'no_hit' })
  } finally { await viewport.dispose() }
})

it('reuses measured geometry and GPU resources for highlight-only changes', async () => {
  const viewport = createViewport(container(), vi.fn())
  try {
    const url = await boxUrl(10, 20, 30, 'retained')
    const spec = { format: 'usd', url, transform: {} }
    const report = await viewport.applyDesign(spec, null)
    const mesh = rendered().getObjectByName('retained')
    const geometry = mesh.geometry, material = mesh.material
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
    material.onBeforeCompile(shader, state.renderer)
    const next = await viewport.applyDesign({ ...spec, highlight: { id: 'new', blobs: [
      { center: [0, 0, 15], radii: [10, 10, 3], rotationDegrees: [0, 0, 0] },
    ] } }, null)
    expect(next).toBe(report)
    expect(mesh.geometry).toBe(geometry)
    expect(mesh.material).toBe(material)
    expect(shader.uniforms.rumiRegionCount.value).toBe(1)
    expect(viewport.renderedHighlight()).toBe('new')
    const resized = await viewport.applyDesign({ ...spec, transform: { scale: 2 } }, null)
    expect(resized).not.toBe(report)
    expect(resized.dimensions).toEqual({ x: 20, y: 40, z: 60 })
  } finally { viewport.dispose() }
})

it('rejects executable previews while preserving the last loaded USD', async () => {
  const viewport = createViewport(container(), vi.fn())
  try {
    await viewport.applyDesign({ format: 'usd', url: await boxUrl(60, 60, 60), transform: {} }, null)
    const mesh = rendered().getObjectByName('design')
    await expect(viewport.applyDesign({ format: 'javascript', url: 'data:text/javascript,throw new Error("executed")', transform: {} }, null)).rejects.toThrow('Project isolation requires a USD')
    expect(rendered().getObjectByName('design')).toBe(mesh)
  } finally { await viewport.dispose() }
})

it('shows USD movement, retains its pose across reloads and restores saved geometry for edits', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(robotUsd())))
  const spec = { path: 'models/car/model.usda', format: 'usd', url: 'https://example.test/model.usda', transform: {} }
  try {
    const report = await viewport.applyDesign(spec, null)
    await viewport.applyShape(null)
    expect(viewport.motionControls().controls.map(control => control.label)).toEqual(['Door'])
    expect(viewport.updateMotion({ joint0: 60 })).toBe(true)
    expect(viewport.modelParameters()).toEqual({ joint0: 0 })
    expect(() => viewport.updateMotion({ joint0: 200 })).toThrow('outside range')
    expect(viewport.motionControls().values).toEqual({ joint0: 60 })
    await viewport.applyDesign({ ...spec, url: spec.url + '?revision=2' }, null)
    await viewport.applyShape(null)
    expect(viewport.motionControls().values).toEqual({ joint0: 60 })
    expect(await viewport.applyDesign({ ...spec, url: spec.url + '?revision=2' }, null)).toEqual(report)
    const visible = []
    rendered().traverseVisible((node) => { if (node.isMesh && node.name === 'Door') visible.push(node) })
    expect(visible).toHaveLength(1)
    expect(Math.atan2(visible[0].matrix.elements[1], visible[0].matrix.elements[0])).toBeCloseTo(Math.PI / 3)
    viewport.updateMotion({ joint0: 0 })
    const reset = []
    rendered().traverseVisible((node) => { if (node.isMesh && node.name === 'Door') reset.push(node) })
    expect(reset).toHaveLength(1)
    expect(reset[0].matrix.elements[1]).toBe(0)
  } finally { viewport.dispose() }
})

it('draws the latest slider pose once per frame and hides the joint when viewed through the assembly', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(robotUsd())))
  const requestFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', requestFrame.mockReturnValue(17))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const spec = { path: 'models/car/model.usda', format: 'usd', url: 'https://example.test/model.usda', transform: {} }
  try {
    await viewport.applyDesign(spec, null)
    const renderer = state.renderer
    const camera = renderer.render.mock.lastCall[1]
    const pivot = rendered().getObjectByName('Body').localToWorld(new THREE.Vector3(.015, 0, 0))
    camera.position.copy(pivot).add(new THREE.Vector3(0, 0, 100))
    camera.lookAt(pivot)
    camera.updateMatrixWorld(true)
    const draw = vi.fn()
    const onCanvasClick = vi.fn()
    const unsubscribe = viewport.observeMotionAnchors(spec.url, draw, onCanvasClick)
    const [anchor] = draw.mock.lastCall[0]
    expect(anchor.x).toBeCloseTo(50, 1)
    expect(anchor.y).toBeCloseTo(50, 1)
    const draws = renderer.render.mock.calls.length
    const settings = { id: spec.url, deferDraw: true }
    requestFrame.mockClear()
    expect(viewport.updateMotion({ joint0: 30 }, settings)).toBe(true)
    expect(viewport.updateMotion({ joint0: 60 }, settings)).toBe(true)
    expect(viewport.updateMotion({ joint0: 90 }, { ...settings, id: '/replaced.usda' })).toBe(false)
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(renderer.render).toHaveBeenCalledTimes(draws)
    requestFrame.mock.lastCall[0]()
    expect(renderer.render).toHaveBeenCalledTimes(draws + 1)
    expect(viewport.motionControls().values).toEqual({ joint0: 60 })
    expect(draw.mock.lastCall[0]).toEqual([anchor])
    camera.position.copy(pivot).add(new THREE.Vector3(-100, 0, 0))
    camera.lookAt(pivot)
    camera.updateMatrixWorld(true)
    viewport.setRegionFocused(false)
    expect(draw.mock.lastCall[0]).toEqual([null])
    camera.position.copy(pivot).add(new THREE.Vector3(0, 0, 100))
    camera.lookAt(pivot)
    camera.updateMatrixWorld(true)
    viewport.setRegionFocused(false)
    expect(draw.mock.lastCall[0]).toEqual([anchor])
    const listener = name => renderer.domElement.addEventListener.mock.calls.find(([kind]) => kind === name)[1]
    const pointer = { isPrimary: true, button: 0, pointerId: 1, clientX: 200, clientY: 150, pointerType: 'mouse' }
    listener('pointerdown')(pointer)
    listener('pointermove')({ ...pointer, clientX: 220 })
    listener('pointerup')({ ...pointer, clientX: 220 })
    expect(onCanvasClick).not.toHaveBeenCalled()
    listener('pointerdown')(pointer)
    listener('pointerup')(pointer)
    expect(onCanvasClick).toHaveBeenCalledOnce()
    const drawn = draw.mock.calls.length
    unsubscribe()
    viewport.updateMotion({ joint0: 0 })
    expect(draw).toHaveBeenCalledTimes(drawn)
  } finally { await viewport.dispose() }
})

it('captures saved hit coordinates and keeps both fixed and posed parts highlighted', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(robotUsd())))
  const spec = { revision: 1, path: 'models/car/model.usda', format: 'usd', url: 'https://example.test/model.usda', transform: {} }
  try {
    await viewport.applyDesign(spec, null)
    await viewport.applyShape(null)
    state.resize()
    const saved = new Map(['Door', 'Body'].map((name) => {
      const mesh = rendered().getObjectByName(name)
      mesh.updateWorldMatrix(true, false)
      let model = mesh.parent
      while (!model.userData.rumiCoordinateFrame) model = model.parent
      while (model.parent?.userData.rumiCoordinateFrame) model = model.parent
      return [name, { mesh, matrix: model.parent.matrixWorld.clone().invert().multiply(mesh.matrixWorld) }]
    }))
    const positions = [...saved.values()].flatMap(({ mesh, matrix }) => {
      const source = mesh.geometry.getAttribute('position')
      const points = [0, 1, 2].map(i => new THREE.Vector3().fromBufferAttribute(source, i).applyMatrix4(matrix))
      // A clipped triangle has no exact face or vertex ID in the source mesh.
      return points.flatMap((point, i) => point.clone().lerp(points[(i + 1) % 3], 0.25).toArray())
    })
    const highlighted = { ...spec, highlight: { id: 'posed-surface', positions: new Float32Array(positions) } }
    const move = state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === 'pointermove')[1]
    for (const angle of [60, 30, 0, 45, 0]) {
      viewport.updateMotion({ joint0: angle })
      const visible = []
      rendered().traverseVisible((node) => { if (node.isMesh && node.name === 'Door') visible.push(node) })
      expect(visible).toHaveLength(1)
      const door = visible[0]
      const camera = state.renderer.render.mock.calls.at(-1)[1]
      const center = new THREE.Box3().setFromObject(door).getCenter(new THREE.Vector3())
      camera.position.copy(center).add(new THREE.Vector3(0, 0, 100))
      camera.up.set(0, 1, 0); camera.lookAt(center); camera.updateMatrixWorld(true)
      move({ pointerType: 'mouse', clientX: 200, clientY: 150 })
      requestAnimationFrame.mock.calls.at(-1)[0]()
      const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
      door.material.onBeforeCompile(shader, state.renderer)
      expect(shader.uniforms.rumiHover.value.w).toBeGreaterThan(0)
      expect(shader.uniforms.rumiCursorMesh.value).toBe(door.id)
      expect(shader.uniforms.rumiMeshId.value).toBe(door.id)
      const capture = viewport.captureCursor()
      expect(capture.status).toBe('captured')
      expect(capture.region.partPath).toEqual(['Model', 'Door'])
      const expected = new THREE.Vector3(...capture.region.worldPoint)
        .applyMatrix4(door.matrixWorld.clone().invert()).applyMatrix4(saved.get('Door')!.matrix)
      expect(expected.distanceTo(new THREE.Vector3(...capture.region.modelLocalPoint))).toBeLessThan(1e-6)
      await viewport.applyDesign(highlighted, null)
      expect(viewport.renderedHighlight()).toBe('posed-surface')
      const overlay = rendered().getObjectByName('Rumi highlight overlay')
      if (angle === 0) expect(overlay.geometry.getAttribute('position').count).toBe(6)
      else {
        expect(overlay.children).toHaveLength(2)
        expect(overlay.children[0].matrix.elements[1]).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(angle)))
        expect(overlay.children[1].matrix.elements[1]).toBe(0)
      }
    }
    const listener = event => state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === event)[1]
    const click = { isPrimary: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 150 }
    listener('pointerdown')(click)
    listener('pointerup')(click)
    const pin = viewport.captureCursor()
    viewport.updateMotion({ joint0: 60 })
    const movedPin = viewport.captureCursor()
    expect(movedPin.region.partPath).toEqual(pin.region.partPath)
    expect(movedPin.region.worldPoint).not.toEqual(pin.region.worldPoint)
    const movedPoint = new THREE.Vector3(...movedPin.region.modelLocalPoint)
    expect(movedPoint.distanceTo(new THREE.Vector3(...pin.region.modelLocalPoint))).toBeLessThan(1e-6)
  } finally { await viewport.dispose() }
})

it('keeps print layout independent from assembly motion, highlights and source revisions', async () => {
  const onPrint = vi.fn(), viewport = createViewport(container(), vi.fn(), vi.fn(), undefined, onPrint)
  const url = 'data:application/octet-stream;base64,' + Buffer.from(robotUsd()).toString('base64')
  const spec = { format: 'usd', path: '/project/models/robot/model.usda', url, contentHash: 'a', revision: 1,
    transform: { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } },
    highlight: { id: 'region', blobs: [{ center: [0, 0, 0], radii: [10, 10, 10], rotationDegrees: [0, 0, 0] }] } }
  await viewport.applyDesign(spec, null)
  const options = { volume: { x: 300, y: 320, z: 320 }, gap: 5 }
  const first = viewport.openPrintLayout(null, options)
  expect(first.manufacturingMode).toBe('separate')
  expect(first.parts).toHaveLength(2)
  expect(first.active).toBe(true)
  expect(viewport.captureCursor().status).toBe('viewer_unavailable')
  expect(viewport.renderedHighlight()).toBeNull()
  const before = first.layout.parts[0].position
  viewport.editPrintPart({ move: [1, 0] })
  expect(viewport.printLayoutState().layout.parts[0].position).toEqual([before[0] + 1, before[1]])
  viewport.undoPrintLayout()
  expect(viewport.printLayoutState().layout.parts[0].position).toEqual(before)
  const plate = viewport.exportPrintPlate()
  expect(plate.getAll('name')).toEqual(first.layout.parts.filter(part => part.plate === 0).map(part => part.id))
  expect(plate.getAll('mesh')).toHaveLength(plate.getAll('name').length)
  viewport.closePrintLayout()
  expect(viewport.printLayoutState().active).toBe(false)
  expect(viewport.renderedHighlight()).toBe('region')
  viewport.openPrintLayout(null, options)
  await viewport.applyDesign({ ...spec, revision: 2, url: url + '#replacement' }, null)
  expect(viewport.printLayoutState()).toMatchObject({ active: false, layout: null })
  await viewport.dispose()
  const notifications = onPrint.mock.calls.length
  await viewport.dispose()
  expect(onPrint.mock.calls).toHaveLength(notifications)
})

it('coalesces print dragging and restores placement when pointer capture is lost', async () => {
  const viewport = createViewport(container(), vi.fn())
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0, captured = false
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  await viewport.applyDesign({ format: 'usd', path: '/project/models/box/model.usda', url: await boxUrl(20, 20, 10),
    revision: 1, contentHash: 'box', transform: { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } } }, null)
  viewport.openPrintLayout(null, { volume: { x: 50, y: 50, z: 50 }, gap: 5 })
  state.resize()
  const canvas = state.renderer.domElement
  canvas.setPointerCapture = () => { captured = true }
  canvas.hasPointerCapture = () => captured
  canvas.releasePointerCapture = () => { captured = false }
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  camera.position.set(0, 0, 200); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const before = viewport.printLayoutState().layout
  const [x, y] = before.parts[0].position
  const point = new THREE.Vector3(x, y, 10).project(camera)
  const event = { button: 0, pointerId: 1, clientX: (point.x + 1) * 200, clientY: (1 - point.y) * 150,
    type: 'pointerdown', stopImmediatePropagation: vi.fn() }
  const listener = (name: string) => canvas.addEventListener.mock.calls.find(
    ([type, _handler, capture]) => type === name && capture === true)[1]
  listener('pointerdown')(event)
  expect(captured).toBe(true)
  const draws = state.renderer.render.mock.calls.length
  for (let step = 1; step <= 10; step++) listener('pointermove')({ ...event, clientX: event.clientX + step })
  expect(frames.size).toBe(1)
  expect(state.renderer.render.mock.calls).toHaveLength(draws)
  const callbacks = [...frames.values()]; frames.clear(); callbacks[0](0)
  expect(state.renderer.render.mock.calls).toHaveLength(draws + 1)
  expect(viewport.printLayoutState().layout).not.toEqual(before)
  listener('lostpointercapture')({ ...event, type: 'lostpointercapture' })
  expect(viewport.printLayoutState().layout).toEqual(before)
  expect(state.controls.enabled).toBe(true)
  await viewport.dispose()
})


it('changes activity uniforms without replacing geometry and excludes work effects from covers', async () => {
  const viewport = createViewport(container(), vi.fn())
  try {
    await viewport.applyDesign({ format: 'usd', url: await boxUrl(10, 20, 30, 'work-subject'), transform: {} }, null)
    const model = rendered().getObjectByName('work-subject'), geometry = model.geometry, material = model.material
    const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
    material.onBeforeCompile(shader, state.renderer)
    viewport.setActivity('building')
    expect(shader.uniforms.rumiActivity.value.x).toBe(1)
    viewport.setActivity('sculpt')
    expect(shader.uniforms.rumiActivity.value.x).toBe(3)
    viewport.setActivity('regions')
    expect(shader.uniforms.rumiActivity.value.x).toBe(4)
    viewport.setActivity('collision')
    expect(shader.uniforms.rumiActivity.value.x).toBe(5)
    viewport.setActivity('fdm')
    expect(shader.uniforms.rumiActivity.value.x).toBe(6)
    viewport.setActivity('mechanics')
    expect(shader.uniforms.rumiActivity.value.x).toBe(7)
    viewport.setActivity('look')
    expect(shader.uniforms.rumiActivity.value.x).toBe(8)
    viewport.setActivity('controls')
    expect(shader.uniforms.rumiActivity.value.x).toBe(9)
    expect(shader.uniforms.rumiActivityMin.value).toBeTruthy()
    expect(shader.uniforms.rumiActivitySize.value).toBeTruthy()
    viewport.setActivity('checking')
    expect(shader.uniforms.rumiActivity.value.x).toBe(2)
    expect(model.geometry).toBe(geometry)
    expect(model.material).toBe(material)
    expect(state.controls.enabled).not.toBe(false)
    const modes: number[] = []
    state.renderer.render.mockImplementation(() => modes.push(shader.uniforms.rumiActivity.value.x))
    viewport.thumbnail()
    expect(modes).toEqual([0, 2])
    viewport.setActivity('idle')
    expect(shader.uniforms.rumiActivity.value.x).toBe(0)
  } finally { await viewport.dispose() }
})

it('retries a failed load when an explicit reload keeps the same URL', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(new Response(robotUsd()))
  vi.stubGlobal('fetch', fetch)
  const viewport = createViewport(container(), vi.fn())
  const spec = { format: 'usd', url: '/retry.usda', transform: {} }
  try {
    await expect(viewport.applyDesign(spec, null)).rejects.toThrow('Connection interrupted')
    await expect(viewport.applyDesign({ ...spec, renderRequest: 'retry' }, null)).resolves.toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally { viewport.dispose() }
})
