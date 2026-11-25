/** Keep USD parsing and mesh cross-section inspection on a disposable background thread. */
import { once } from 'node:events'
import { Worker, parentPort, workerData } from 'node:worker_threads'
import { badgeTurnEvidence, inspectPrintBadgeParts, readPrintBadgeEvidence } from './badge-review-evidence.js'

if (parentPort && workerData?.task === 'print-badge-inspection') {
  const { projectRoot, target, evidence } = workerData
  const model = await readPrintBadgeEvidence(projectRoot, target, evidence, new AbortController().signal)
  if (model) {
    parentPort.on('message', requests => parentPort.postMessage(inspectPrintBadgeParts(model.geometry, requests)))
    parentPort.postMessage({ revision: model.revision, sourceHash: model.sourceHash, pinned: model.pinned, facts: model.facts })
  } else {
    parentPort.postMessage(null)
  }
}

/**
 * Open read-only inspection for one published revision. The caller closes it after classification.
 * @param {string} projectRoot Canonical owner of the model.
 * @param {object} target Saved model identity at the completed turn.
 * @param {object[]} events Events bounded by that turn.
 * @param {AbortSignal} signal Disposal or deadline for this review.
 * @returns {Promise<object|null>} Compact measurements and a method for requesting local sections.
 */
export async function inspectSavedBadgeRevision(projectRoot, target, events, signal) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./badge-review-worker.js', import.meta.url), {
    name: 'print-badge-inspection', execArgv: [],
    workerData: { task: 'print-badge-inspection', projectRoot, target, evidence: badgeTurnEvidence(events) },
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  })
  const stopped = new AbortController()
  worker.on('error', error => stopped.abort(error))
  worker.once('exit', () => stopped.abort(new Error('Print Studio badge inspection ended')))
  const lifetime = AbortSignal.any([signal, stopped.signal])
  let settlement
  function close() {
    signal.removeEventListener('abort', close)
    settlement ??= worker.terminate()
    return settlement
  }
  signal.addEventListener('abort', close, { once: true })
  async function receive(requests) {
    lifetime.throwIfAborted()
    const response = once(worker, 'message', { signal: lifetime })
    if (requests) worker.postMessage(requests)
    const [message] = await response
    return message
  }
  try {
    const model = await receive()
    if (model) return { ...model, inspect: receive, close }
    await close()
    return null
  } catch (error) {
    await close()
    throw error
  }
}
