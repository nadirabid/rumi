/** Live badge notices for connected owner clients. */

const encoder = new TextEncoder()
const connected = encoder.encode(': connected\n\n')
const maxQueueBytes = 64 * 1024

/**
 * Create an SSE publisher for the lifetime of one badge host.
 * @returns {object} Live responses, post-commit publication, and subscriber disposal.
 */
export function createBadgeEvents() {
  const subscribers = new Set()
  let closed = false
  return {
    /**
     * Open an authenticated client's stream of future award notices.
     * @param {AbortSignal} signal The client request's lifetime.
     * @returns {Response} A stream that closes on request cancellation, disposal, or queue overflow.
     */
    response(signal) {
      let unsubscribe = () => {}
      const body = new ReadableStream({
        start(controller) {
          if (closed || signal.aborted) {
            controller.close()
            return
          }
          const subscriber = {
            send(frame) {
              if (controller.desiredSize < frame.byteLength) subscriber.close()
              else controller.enqueue(frame)
            },
            close() {
              unsubscribe()
              controller.close()
            },
          }
          unsubscribe = () => {
            subscribers.delete(subscriber)
            signal.removeEventListener('abort', subscriber.close)
          }
          subscribers.add(subscriber)
          signal.addEventListener('abort', subscriber.close, { once: true })
          controller.enqueue(connected)
        },
        cancel() { unsubscribe() },
      }, new ByteLengthQueuingStrategy({ highWaterMark: maxQueueBytes }))
      return new Response(body, { headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      } })
    },
    /**
     * Send one batch to the owner clients already listening.
     * @param {Omit<import('./event-types.d.ts').PrintBadgeEarned, 'projectPath'>} event Public award fields.
     */
    publish(event) {
      const frame = encoder.encode(`event: badge-earned\ndata: ${JSON.stringify(event)}\n\n`)
      for (const subscriber of subscribers) subscriber.send(frame)
    },
    close() {
      closed = true
      for (const subscriber of subscribers) subscriber.close()
    },
  }
}
