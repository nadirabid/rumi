import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import * as ChatGPT from '../brand/chatgpt.js'

it('uses the resolved request byte budget for images on the saved ChatGPT route', async () => {
  const registerAdapter = vi.fn<(providers: string[], adapter: LlmAdapter) => void>()
  const ctx = {
    connection: { fetch: { register: () => () => {} } },
    credentials: { readRecord: async () => ({ payload: { models: [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }] } }) },
    llm: { registerAdapter },
    storageDomain: { open: async () => ({ table: () => ({}), close: () => {} }) },
    effect: () => {},
  }
  await ChatGPT.apply(ctx, ChatGPT.Config.parse({ maxRequestImageBytes: 8000, maxRequestImages: 2, requestImageMaxBytes: 4000 }))
  const [providers, adapter] = registerAdapter.mock.calls[0]!
  expect(providers).toEqual(['rumi-chatgpt'])
  expect(adapter.imageRequestTarget('rumi-chatgpt', 'gpt-6.2-sol', {
    attachmentId: AttachmentId('sha256:' + '0'.repeat(64)), mediaType: 'image/png', bytes: 6000, width: 64, height: 64,
  })).toMatchObject({ maxImageBytes: 3000, imageTargetBytes: 3000 })
})
