/** Display and validation share immutable artifacts while preview generation stays separate. */
import { expect, it, vi } from 'vitest'
import { createModelArtifacts } from '../viewer/generation/artifacts.js'
import { assemblyGlb } from './fixtures/assembly-glb.js'

it('reuses saved bytes across display and validation URLs for one source hash', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(assemblyGlb()))
  const artifacts = createModelArtifacts()
  try {
    const displayed = await artifacts.resolve({ format: 'glb', contentHash: 'same', url: '/display' })
    const release = displayed.retain()
    const validation = await artifacts.resolve({ format: 'glb', contentHash: 'same', url: '/validation' })
    expect(validation.bytes).toBe(displayed.bytes)
    expect(fetcher).toHaveBeenCalledTimes(1)
    release()
  } finally { await artifacts.dispose(); fetcher.mockRestore() }
})

it('does not publish an artifact after its owner is disposed', async () => {
  const response = Promise.withResolvers<Response>()
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(response.promise)
  const artifacts = createModelArtifacts()
  try {
    const loading = artifacts.resolve({ format: 'glb', url: '/late' })
    const rejected = expect(loading).rejects.toThrow('closed')
    const disposed = artifacts.dispose()
    response.resolve(new Response(assemblyGlb()))
    await rejected; await disposed
    await expect(artifacts.resolve({ format: 'glb', url: '/late' })).rejects.toThrow('closed')
  } finally { await artifacts.dispose(); fetcher.mockRestore() }
})

it('rejects executable model sources before importing or fetching them', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const artifacts = createModelArtifacts()
  try {
    for (const format of ['javascript', undefined]) {
      await expect(artifacts.resolve({ format, url: 'data:text/javascript,throw new Error("project code executed")' })).rejects.toThrow('Project isolation requires a GLB preview')
    }
    expect(fetcher).not.toHaveBeenCalled()
  } finally { await artifacts.dispose(); fetcher.mockRestore() }
})
