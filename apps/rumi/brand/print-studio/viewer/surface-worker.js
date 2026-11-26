/** Run mesh measurements or resolve saved feature selectors off the host thread. */
import { Worker } from 'node:worker_threads'

/** @param {Uint8Array} bytes @param {object[]} regions @param {AbortSignal} signal @param {boolean} selectorsOnly @returns {Promise<object>} Worker result. */
export async function loadInventory(bytes, regions, signal, selectorsOnly = false) {
  signal.throwIfAborted()
  const buffer = Uint8Array.from(bytes).buffer
  const worker = new Worker(new URL('./surface-analysis-worker.js', import.meta.url), {
    workerData: { bytes: buffer, regions, selectorsOnly }, transferList: [buffer], execArgv: [],
  })
  let cancel
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`Mesh analysis exited before returning its measurements (code ${code})`)))
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    await worker.terminate()
  }
}
