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
          setAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn(),
        }
        this.domElement.toDataURL = vi.fn(() => 'data:image/png;base64,cG5n')
        this.ratio = 1
        this.setPixelRatio = vi.fn(value => { this.ratio = value })
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
      this.target = { copy: vi.fn() }
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
  vi.stubGlobal('window', { devicePixelRatio: 1 })
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
  expect(first.geometry).toBe(second.geometry)
  expect(dispose).not.toHaveBeenCalled()
  viewport.apply({ volume: null, objects: [object('o2')] })
  expect(meshes()).toHaveLength(1)
  expect(dispose).not.toHaveBeenCalled()
  viewport.apply({ volume: null, objects: [] })
  expect(dispose).toHaveBeenCalledTimes(1)
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
  expect(scene.getObjectByName('design').geometry.parameters.width).toBe(20)
  await expect(viewport.applyDesign({ ...spec, url: 'data:text/javascript,export function build(){throw new Error("broken")}' }, null)).rejects.toThrow('broken')
  expect(scene.getObjectByName('design').geometry.parameters.width).toBe(20)
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
  expect(rendered().getObjectByName('newest').geometry.parameters.width).toBe(50)
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
  const shader = { uniforms: { rumiReveal: { value: 1 } }, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <opaque_fragment>' }
  material.onBeforeCompile(shader, state.renderer)
  expect(shader.fragmentShader).toContain('vec3(0.18, 0.40, 0.37)')
  viewport.setHighlightVisible(false)
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
  expect(disposeGeometry).toHaveBeenCalledOnce()
  expect(disposeMaterial).toHaveBeenCalledOnce()
  expect(design.geometry.getAttribute('rumiBarycentric')).toBeUndefined()
  expect(design.material).not.toBe(material)
  viewport.dispose()
})
