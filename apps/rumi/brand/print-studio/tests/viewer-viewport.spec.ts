/** The viewport reconciles a scene view into real three objects and owns every resource it makes. */
import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createViewport } from '../viewer/viewport/index.js'

const state = vi.hoisted(() => ({ renderer: null, controls: null, resize: null }))
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
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
    addEventListener() {}
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  state.renderer = null
  state.controls = null
})

function container() {
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#888888' }))
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { this.disconnect = vi.fn(); state.resize = callback }
    observe() {}
  })
  return { appendChild: vi.fn(), getBoundingClientRect: () => ({ width: 400, height: 300 }) }
}

const positions = () => new Float32Array([0, 0, 0, 12, 0, 0, 0, 12, 0])
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const object = (id: string, datablockId: string = 'd1', matrix: number[] = identity) => ({ id, datablockId, positions: positions(), matrix, blocked: false })
const meshes = () => state.renderer.render.mock.calls.at(-1)[0].children.filter(child => child.isMesh)
const rendered = () => state.renderer.render.mock.calls.at(-1)[0]

it('draws one object per scene entry and applies the matrix the host measured with', () => {
  const viewport = createViewport(container(), vi.fn())
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
  viewport.apply({ volume: null, objects: [object('o1', 'd1', matrix)] })
  const [mesh] = meshes()
  expect(mesh.matrix.elements).toEqual(matrix)
  expect(mesh.geometry.getAttribute('position').count).toBe(3)
  viewport.dispose()
})

it('shares one geometry between placements of the same datablock and disposes it with the last one', () => {
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
  const viewport = createViewport(container(), vi.fn())
  viewport.apply({ volume: null, objects: [object('o1'), object('o2')] })
  const [first, second] = meshes()
  expect(first.geometry.getAttribute('position').array).toEqual(second.geometry.getAttribute('position').array)
  expect(dispose).not.toHaveBeenCalled()
  viewport.apply({ volume: null, objects: [object('o2')] })
  expect(meshes()).toHaveLength(1)
  expect(dispose).toHaveBeenCalledTimes(1)
  viewport.apply({ volume: null, objects: [] })
  expect(dispose).toHaveBeenCalledTimes(3)
  viewport.dispose()
})

it('draws the plate, grid, and envelope for a print volume and replaces them when it changes', () => {
  const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
  const viewport = createViewport(container(), vi.fn())
  viewport.apply({ volume: { x: 300, y: 320, z: 320 }, objects: [object('o1')] })
  expect(rendered().children.filter(child => child.isLineSegments)).toHaveLength(2)
  expect(rendered().children.filter(child => child.isMesh)).toHaveLength(2)
  viewport.apply({ volume: { x: 200, y: 200, z: 200 }, objects: [object('o1')] })
  expect(dispose).toHaveBeenCalledTimes(3)
  expect(rendered().children.filter(child => child.isLineSegments)).toHaveLength(2)
  viewport.dispose()
})

it('keeps the camera across scene updates and frames once', () => {
  const viewport = createViewport(container(), vi.fn())
  viewport.apply({ volume: null, objects: [object('o1')] })
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  viewport.apply({ volume: null, objects: [object('o1', 'd1', [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 40, 0, 0, 1])] })
  expect(camera.position.distanceTo(position)).toBe(0)
  viewport.dispose()
})

it('frames the scene once the canvas has a size, using the field that actually fits', () => {
  const viewport = createViewport(container(), vi.fn())
  viewport.apply({ volume: null, objects: [object('o1')] })
  state.resize?.()
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  expect(camera.position.length()).toBeGreaterThan(0)
  expect(Number.isFinite(camera.position.x)).toBe(true)
  expect(state.controls.target.copy).toHaveBeenCalledTimes(1)
  viewport.dispose()
})

it('releases the renderer, the controls, and every resource once', () => {
  const viewport = createViewport(container(), vi.fn())
  viewport.apply({ volume: { x: 100, y: 100, z: 100 }, objects: [object('o1')] })
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
  const module = (width: number) => `data:text/javascript,${encodeURIComponent(`export function build(T) { const mesh = new T.Mesh(new T.BoxGeometry(${width}, 2, 3), new T.MeshStandardMaterial()); mesh.name = 'design'; return mesh }`)}`
  const spec = { url: module(10), transform: { scale: 1, rotate: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } } }
  const report = await viewport.applyDesign(spec, null)
  expect(report.dimensions.x).toBe(10)
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  await viewport.applyDesign({ ...spec, url: module(20) }, null)
  expect(camera.position.equals(position)).toBe(true)
  const scene = rendered()
  expect(new THREE.Box3().setFromObject(scene.getObjectByName('design')).getSize(new THREE.Vector3()).x).toBe(20)
  await expect(viewport.applyDesign({ ...spec, url: 'data:text/javascript,export function build(){throw new Error("broken")}' }, null)).rejects.toThrow('broken')
  expect(new THREE.Box3().setFromObject(scene.getObjectByName('design')).getSize(new THREE.Vector3()).x).toBe(20)
  viewport.dispose()
})

it('discards an imported model that completes after the viewport is disposed', async () => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  vi.stubGlobal('__rumiModelImport', new Promise<void>((resolve) => { release = resolve }))
  vi.stubGlobal('__rumiModelStarted', started)
  const built = vi.fn()
  vi.stubGlobal('__rumiModelBuilt', built)
  const viewport = createViewport(container(), vi.fn())
  const url = `data:text/javascript,${encodeURIComponent('globalThis.__rumiModelStarted(); await globalThis.__rumiModelImport; export function build(T) { globalThis.__rumiModelBuilt(); return new T.Mesh(new T.BoxGeometry(1, 2, 3)) }')}`
  const loading = viewport.applyDesign({ url, transform: {} }, null)
  await entered
  viewport.dispose()
  release()
  expect(await loading).toBeNull()
  expect(built).not.toHaveBeenCalled()
})

it('keeps the latest revision when an older import completes later', async () => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  vi.stubGlobal('__rumiOlderImport', new Promise<void>((resolve) => { release = resolve }))
  vi.stubGlobal('__rumiOlderStarted', started)
  const viewport = createViewport(container(), vi.fn())
  const older = `data:text/javascript,${encodeURIComponent('globalThis.__rumiOlderStarted(); await globalThis.__rumiOlderImport; export function build(T) { return new T.Mesh(new T.BoxGeometry(1, 2, 3)) }')}`
  const newer = `data:text/javascript,${encodeURIComponent('export function build(T) { const mesh = new T.Mesh(new T.BoxGeometry(50, 2, 3)); mesh.name = "newest"; return mesh }')}`
  const first = viewport.applyDesign({ url: older, transform: {} }, null)
  await entered
  const report = await viewport.applyDesign({ url: newer, transform: {} }, null)
  expect(report.dimensions.x).toBe(50)
  release()
  expect(await first).toBeNull()
  expect(new THREE.Box3().setFromObject(rendered().getObjectByName('newest')).getSize(new THREE.Vector3()).x).toBe(50)
  viewport.dispose()
})

it('frames the current design before applying a requested camera angle', async () => {
  const viewport = createViewport(container(), vi.fn())
  const url = `data:text/javascript,${encodeURIComponent('export function build(T) { return new T.Mesh(new T.BoxGeometry(100, 20, 30)) }')}`
  await viewport.applyDesign({ url, transform: {}, camera: { id: 'front', azimuth: 0, elevation: 0 } }, null)
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  expect(camera.position.x).toBeCloseTo(0)
  expect(camera.position.y).toBeLessThan(-100)
  expect(camera.position.z).toBeCloseTo(15)
  viewport.dispose()
})


it('captures loaded geometry at cover size and restores the viewport even when encoding fails', () => {
  const viewport = createViewport(container(), vi.fn())
  expect(viewport.thumbnail()).toBeNull()
  viewport.apply({ volume: { x: 200, y: 200, z: 200 }, objects: [object('cover')] })
  state.resize()
  const scene = rendered()
  const geometry = meshes()[0].geometry
  const camera = state.renderer.render.mock.calls.at(-1)[1]
  const position = camera.position.clone()
  state.renderer.domElement.toDataURL.mockImplementation(() => {
    expect(state.renderer.domElement.width).toBe(480)
    expect(state.renderer.domElement.height).toBe(320)
    expect(scene.children.filter(node => node.isLineSegments).every(node => !node.visible)).toBe(true)
    throw new Error('encoding failed')
  })
  expect(() => viewport.thumbnail()).toThrow('encoding failed')
  expect(state.renderer.domElement.width).toBe(400)
  expect(state.renderer.domElement.height).toBe(300)
  expect(scene.children.every(node => node.visible)).toBe(true)
  expect(meshes()[0].geometry).toBe(geometry)
  expect(camera.position.equals(position)).toBe(true)
  viewport.dispose()
  expect(viewport.thumbnail()).toBeNull()
})

it('owns a temporary overlay separately from design geometry and excludes it from covers', async () => {
  const viewport = createViewport(container(), vi.fn())
  const url = `data:text/javascript,${encodeURIComponent('export function build(T) { const m = new T.Mesh(new T.BoxGeometry(10, 20, 30)); m.name = "highlight-subject"; return m }')}`
  const spec = { url, transform: {}, highlight: { id: 'region-1', label: 'Top', blobs: [
    { center: [0, 0, 15], radii: [10, 10, 3], rotationDegrees: [0, 0, 0] },
  ] } }
  const report = await viewport.applyDesign(spec, null)
  const design = rendered().getObjectByName('highlight-subject')
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
  const render = vi.fn()
  const hover = createHover(canvas, camera, () => [mesh], render)
  const flush = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()) }
  try {
    listeners.get('pointermove')!({ clientX: 0, clientY: 0, pointerType: 'mouse' })
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    expect(frames.size).toBe(1)
    flush()
    expect(render).toHaveBeenCalledOnce()
    expect(hover.sphere.value.z).toBeCloseTo(1)
    expect(hover.sphere.value.w).toBeGreaterThan(0)
    const anchor = hover.snapshot()
    listeners.get('pointermove')!({ clientX: 390, clientY: 200, pointerType: 'mouse' })
    expect(hover.refine('surface', anchor).point.toArray()).toEqual(anchor.point.toArray())
    expect(hover.mode.value).toBe(1)
    expect(frames.size).toBe(0)
    expect(hover.surface.value).toBe(anchor.surfaceId)
    listeners.get('pointermove')!({ clientX: 200, clientY: 200, pointerType: 'mouse' })
    flush()
    mesh.position.z = 2
    hover.invalidate()
    flush()
    expect(hover.sphere.value.z).toBeCloseTo(3)
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
  }
})

it('captures the same displayed Gaussian in model coordinates and restores screenshot sizing', async () => {
  const viewport = createViewport(container(), vi.fn())
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  try {
    viewport.apply({ revision: 7, volume: null, objects: [] })
    const url = `data:text/javascript,${encodeURIComponent('export function build(T) { const m = new T.Mesh(new T.BoxGeometry(10,10,10)); m.name="faceplate"; return m }')}`
    const transform = { scale: 2, rotate: { x: 0, y: 0, z: 30 }, position: { x: 4, y: 8, z: 0 } }
    await viewport.applyDesign({ path: '/model.js', revision: 3, url, transform }, null)
    state.resize()
    const camera = state.renderer.render.mock.calls.at(-1)[1]
    camera.lookAt(state.controls.target)
    const move = state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === 'pointermove')[1]
    move({ clientX: 200, clientY: 150, pointerType: 'mouse' })
    const capture = viewport.captureCursor()
    expect(capture.status).toBe('captured')
    expect(capture.identity).toEqual({ sceneRevision: 7, design: { path: '/model.js', revision: 3, url, transform } })
    expect(capture.region.partPath).toEqual(['faceplate'])
    expect(capture.region.objectId).toBeNull()
    expect(capture.region.modelLocalBlob.radii[0]).toBeCloseTo(capture.region.worldRadius / 2)
    const root = rendered().getObjectByName('faceplate').parent
    const world = new THREE.Vector3(...capture.region.modelLocalBlob.center).applyMatrix4(root.matrixWorld)
    expect(world.distanceTo(new THREE.Vector3(...capture.region.worldPoint))).toBeLessThan(1e-6)
    expect(capture.image).toBe('data:image/png;base64,cG5n')
    expect(state.renderer.domElement.width).toBe(400)
    expect(state.renderer.domElement.height).toBe(300)
    const leave = state.renderer.domElement.addEventListener.mock.calls.find(([name]) => name === 'pointerleave')[1]
    leave()
    expect(viewport.captureCursor()).toEqual({ status: 'no_hit' })
    const refined = viewport.captureCursor({ command: 'surface', anchorId: capture.region.anchorId })
    expect(refined.status).toBe('captured')
    expect(refined.region.worldPoint).toEqual(capture.region.worldPoint)
    expect(refined.region.selection.mode).toBe('surface')
    await viewport.applyDesign({ path: '/model.js', revision: 3, url, transform: { ...transform, scale: 3 } }, null)
    expect(viewport.captureCursor({ command: 'part', anchorId: refined.region.anchorId })).toEqual({ status: 'stale_view' })
  } finally { viewport.dispose() }
})

it('reuses measured geometry and GPU resources for highlight-only changes', async () => {
  const viewport = createViewport(container(), vi.fn())
  try {
    const url = `data:text/javascript,${encodeURIComponent('export function build(T) { const m = new T.Mesh(new T.BoxGeometry(10, 20, 30)); m.name = "retained"; return m }')}`
    const spec = { url, transform: {} }
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

it('updates parameter controls opened after loading synchronously and preserves geometry on a failed rebuild', async () => {
  const viewport = createViewport(container(), vi.fn())
  const url = 'data:text/javascript,' + encodeURIComponent('export const parameters={size:60};export function build(THREE,p){if(p.size>80)throw new Error("Too large");return new THREE.Mesh(new THREE.BoxGeometry(p.size,p.size,p.size),new THREE.MeshStandardMaterial())}')
  try {
    await viewport.applyDesign({ url, transform: {}, analog: null }, null)
    viewport.applyShape({ id: 'parameters', operation: 'parameters', label: 'Size', values: { size: 60 }, controls: [
      { kind: 'slider', label: 'Size', axes: [{ key: 'size', min: 20, max: 120, step: 1, reset: 60 }] },
    ] })
    expect(() => viewport.updateShape({ size: 90 })).toThrow('Too large')
    expect(() => viewport.updateShape({ size: 70 })).not.toThrow()
  } finally { viewport.dispose() }
})
