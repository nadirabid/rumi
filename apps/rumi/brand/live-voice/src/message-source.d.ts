/** Logged visual context paired with a spoken user message. */
import type { ContextFormed, MessageId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rumi-voice-reference': { kind: 'rumi-voice-reference'; userMessageId: MessageId } & ContextFormed
  }
}
