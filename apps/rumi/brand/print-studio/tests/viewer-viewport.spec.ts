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
        this.setPixelRatio = vi.fn()
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
