/** Bound request images through the harness's durable image-offload recovery. */
import { z } from 'zod'
import { IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'

export const inject = ['llm']

/** Maximum retained input-image occurrences in each model request. */
export const Config = z.object({ maxImages: z.number().int().positive() })

/**
 * Reject excess images locally so ordinary offload recovery logs the oldest omissions.
 * Saved attachments and text findings remain intact; retries send the newest images.
 * @param {object} ctx - Plugin context owning the stream listener.
 * @param {{ maxImages: number }} config - Validated request image budget.
 */
export function apply(ctx, config) {
  ctx.on('llm/stream', async function* (options, next) {
    const count = options.messages.reduce((total, message) => total + message.content.filter(
      block => block.type === 'image' && block.offloaded !== true,
    ).length, 0)
    if (count > config.maxImages) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: IMAGE_OFFLOAD_REQUIRED_CODE,
            message: `Rumi retains at most ${config.maxImages} images per request.`,
            offloadImages: count - config.maxImages,
          },
        },
      }
      return
    }
    yield* next()
  })
}
