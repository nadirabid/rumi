/** Keep spoken user text separate from logged, model-facing visual context. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Pair a spoken message with optional non-human context for the same next-step inbox.
 * @param {string} text - The user's transcribed words, unchanged.
 * @param {import('@deepseek-ai/dsh-llm').ContentBlock[]} content - Captured reference blocks; empty means no reference message.
 * @returns {object} User message and nullable reference, submitted in reference-first order.
 */
export function createVoiceMessages(text, content) {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  const reference = content.length ? createUserMessage({
    content,
    source: { kind: 'rumi-voice-reference', form: 'notice', summary: 'Pointing reference', userMessageId: message.id },
  }) : null;
  return { message, reference };
}
