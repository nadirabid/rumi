/** Live project metadata updates for connected owner clients. */

const encoder = new TextEncoder()
const connected = encoder.encode(': connected\n\n')
const maxQueueBytes = 64 * 1024

/**
 * Create an SSE publisher for project updates over one host plugin lifetime.
 * @returns {{ response: (signal: AbortSignal) => Response, publish: (project: object) => void, close: () => void }} Stream response builder, publisher, and disposal.
 */
export function createProjectEvents() {
  const subscribers = new Set()
  let closed = false
  return {
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
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
        },
      })
    },
    publish(project) {
      const frame = encoder.encode(`event: project-updated\ndata: ${JSON.stringify({ project })}\n\n`)
      for (const subscriber of subscribers) subscriber.send(frame)
    },
    close() {
      closed = true
      for (const subscriber of subscribers) subscriber.close()
    },
  }
}
