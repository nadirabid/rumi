/** Client-owned GLB generation cache shared by display and validation. */
import { validateGlb, GLB_MAX_BYTES } from '../glb.js'

/**
 * Own immutable saved artifacts; displayed entries stay pinned until released.
 * Preview generation bypasses the saved cache. Disposal waits for all generation work.
 * @returns {object} Resolve, retain and disposal operations for this client instance.
 */
export function createModelArtifacts() {
  const entries = new Map(), pending = new Set()
  const controller = new AbortController()
  let closed = false
  function track(work) {
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => {})
    return work
  }
  function prune() {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.artifact?.bytes.byteLength ?? 0), 0)
    for (const [key, entry] of entries) {
      if (bytes <= GLB_MAX_BYTES && entries.size <= 32) break
      if (!entry.artifact || entry.references) continue
      entries.delete(key); bytes -= entry.artifact.bytes.byteLength
    }
  }
  return {
    async resolve(request) {
      if (closed) throw new Error('Model generation is closed')
      prune()
      const format = request.format
      if (format !== 'glb') throw new Error('Project isolation requires a GLB preview. Export this model to models/<name>/model.glb.')
      const key = JSON.stringify([format, request.contentHash ?? request.url,
        request.contentHash ? null : request.parameters ?? {}])
      let entry = entries.get(key)
      if (!entry) {
        entry = { references: 0, artifact: null, work: null }
        entries.set(key, entry)
        const current = entry
        current.work = track((async () => {
          const response = await fetch(request.url, { signal: controller.signal })
          if (!response.ok) throw new Error(`GLB load failed (${response.status})`)
          const bytes = await response.arrayBuffer()
          validateGlb(new Uint8Array(bytes))
          const result = { bytes, parameters: {} }
          if (closed) throw new Error('Model generation is closed')
          current.artifact = { ...result, retain() {
            if (closed) throw new Error('Model generation is closed')
            current.references++
            let released = false
            return () => { if (!released) { released = true; current.references--; prune() } }
          } }
          return current.artifact
        })()).catch(error => { if (entries.get(key) === current) entries.delete(key); throw error })
      }
      const artifact = await entry.work
      if (closed) throw new Error('Model generation is closed')
      entries.delete(key); entries.set(key, entry)
      // The caller can pin the returned artifact before the next cache operation.
      return artifact
    },
    async dispose() {
      closed = true
      controller.abort()
      await Promise.allSettled([...pending])
      entries.clear()
    },
  }
}
