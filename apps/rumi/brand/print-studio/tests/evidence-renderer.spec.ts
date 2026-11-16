// @vitest-environment jsdom
/** Evidence generation must finish without background-tab timer wakeups. */
import { setImmediate } from 'node:timers/promises'
import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { renderControlEvidence } from '../viewer/analog/evidence-renderer.js'
import { controlReviewCases } from '../viewer/analog/review-cases.js'

const gpu = vi.hoisted(() => ({ dispose: vi.fn(), forceContextLoss: vi.fn(), render: vi.fn() }))
vi.mock('three', async importOriginal => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class {
    domElement = document.createElement('canvas')
    setSize() {}
    setPixelRatio() {}
    render = gpu.render
    dispose = gpu.dispose
    forceContextLoss = gpu.forceContextLoss
  },
}))
vi.mock('../viewer/viewport/usd.js', () => ({
  parseUsdModel: async () => {
    const root = new THREE.Group(), geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
    mesh.name = 'Shell'; root.add(mesh)
    return { root }
  },
}))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function request() {
  const offsets = Array(81).fill(0); offsets[40] = 3
  const spec = { operation: 'fields', parts: ['Shell'], values: { depth: 0 },
    fields: [{ key: 'depth', origin: [-10, -10, -10], spacing: [10, 10, 10], dimensions: [3, 3, 3], offsets }],
    controls: [{ kind: 'slider', label: 'Depth', axes: [{ key: 'depth', min: -1, max: 1, step: .1, reset: 0 }] }],
  }
  return { spec, ...controlReviewCases(spec) }
}
function canvas() {
  // GPU pixels have separate real-browser coverage; this fixture exercises scheduling and mesh measurements.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn<CanvasRenderingContext2D['fillRect']>(), fillText: vi.fn<CanvasRenderingContext2D['fillText']>(), drawImage: vi.fn<CanvasRenderingContext2D['drawImage']>() } as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n')
}

it('renders every endpoint and combination when timer wakeups are unavailable', async () => {
  canvas()
  vi.stubGlobal('scheduler', { yield: () => setImmediate() })
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => { throw new Error('Background timer wakeups are unavailable') })
  const job = request()
  const result = await renderControlEvidence(new ArrayBuffer(0), job, new AbortController().signal)
  expect(result).toMatchObject({
    status: 'complete', neutralMaxDisplacementMm: 0,
    cases: ['depth:min', 'depth:max', 'combined:min', 'combined:max'].map(id => ({ id, maxDisplacementMm: 3, image: 'data:image/png;base64,cG5n' })),
  })
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.forceContextLoss).toHaveBeenCalledOnce()
})

it('releases the renderer when cancelled between cases', async () => {
  canvas()
  const controller = new AbortController()
  vi.stubGlobal('scheduler', { yield: async () => { controller.abort(); await setImmediate() } })
  await expect(renderControlEvidence(new ArrayBuffer(0), request(), controller.signal)).rejects.toThrow()
  expect(gpu.dispose).toHaveBeenCalledOnce()
  expect(gpu.forceContextLoss).toHaveBeenCalledOnce()
})
