import { isDelegation } from './protocol.js';

/**
 * One live voice session's worth of bridge state.
 *
 * GPT-Live pushes a delegation when it wants the harness to do something, and
 * gives no task text: the request is whatever the user said since the previous
 * delegation. This class owns that mapping — buffer the user's speech, turn it
 * into one task per delegation. With a steering callback, corrections join the
 * active interval and its result answers the latest delegation; otherwise tasks queue.
 *
 * It is deliberately free of Cordis, WebSocket, and audio concerns so it can be
 * tested on its own.
 */
export class LiveBridge {
  /** @type {string} */
  #buffer = '';
  /** @type {{delegationId: string, text: string, startedAt: number} | null} */
  #inFlight = null;
  /** @type {{delegationId: string, text: string}[]} */
  #queue = [];
  /** @type {Set<string>} */
  #seen = new Set();
  #closed = false;
  #waiting = null;

  /**
   * @param {object} options
   * @param {(task: {delegationId: string, text: string}) => void} options.dispatch
   * @param {(task: {delegationId: string, text: string}) => void} [options.steer] Deliver corrections to the active interval; omitted queues them.
   * @param {(delegationId: string, content: string) => void} options.commentary
   * @param {(delegationId: string | null, content: string) => void} options.thinking
   * @param {number} [options.transcriptWaitMs] Maximum wait for text after an early delegation.
   * @param {Function} [options.state] Reports received, waiting, dispatching, or failed handoffs.
   * @param {() => number} [options.now]
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.maxBufferChars]
   */
  constructor({ dispatch, steer, commentary, thinking, transcriptWaitMs = 5000, state = () => {}, now = Date.now, log = () => {}, maxBufferChars = 4_000 }) {
    this.transcriptWaitMs = transcriptWaitMs;
    this.state = state;
    this.dispatch = dispatch;
    this.steer = steer;
    this.commentary = commentary;
    this.thinking = thinking;
    this.now = now;
    this.log = log;
    this.maxBufferChars = maxBufferChars;
  }

  get busy() {
    return this.#inFlight !== null;
  }

  get closed() {
    return this.#closed;
  }

  /** State for the status surface. */
  snapshot() {
    return {
      closed: this.#closed,
      waitingForTranscript: this.#waiting !== null,
      inFlight: this.#inFlight ? { ...this.#inFlight } : null,
      queued: this.#queue.length,
      buffered: this.#buffer.length,
    };
  }

  /**
   * Feed one server event.
   * @param {any} event
   * @returns {'delegation' | 'dispatched' | 'steered' | 'queued' | 'waiting' | 'ignored'}
   */
  handleLiveEvent(event) {
    if (this.#closed) return 'ignored';
    switch (event?.type) {
      case 'session.input_transcript.delta':
        if (typeof event.delta === 'string') this.#buffer = (this.#buffer + event.delta).slice(-this.maxBufferChars);
        if (this.#waiting && this.#buffer.trim()) {
          const id = this.#waiting.id;
          clearTimeout(this.#waiting.timer);
          this.#waiting = null;
          return this.#deliver(id, this.#takeTask());
        }
        return 'ignored';
      case 'session.delegation.created':
        return this.#onDelegation(event);
      case 'session.closed':
        this.close();
        return 'ignored';
      case 'error':
        this.log(`live error: ${event.error?.code ?? ''} ${event.error?.message ?? ''}`.trim());
        return 'ignored';
      default:
        return 'ignored';
    }
  }

  /**
   * Called when the harness turn started from the current task settles.
   * @param {{text?: string, ok?: boolean}} [result]
   */
  turnFinished(result = {}) {
    const task = this.#inFlight;
    this.#inFlight = null;
    if (!task) return;
    if (!this.#closed) {
      const text = result.ok === false
        ? `That failed. ${(result.text ?? '').trim()}`.trim()
        : summarize(result.text ?? '');
      this.commentary(task.delegationId, text || 'That finished, with no output to report.');
    }
    this.#drain();
  }

  /** Stop accepting requests and discard work that has not started. */
  close() {
    this.#closed = true;
    if (this.#waiting) clearTimeout(this.#waiting.timer);
    this.#waiting = null;
    this.#queue = [];
    this.#buffer = "";
  }

  #drain() {
    if (this.#closed) return;
    const next = this.#queue.shift();
    if (next) this.#start(next);
  }

  #onDelegation(event) {
    if (!isDelegation(event)) return 'ignored';
    const id = event.delegation.id;
    if (this.#seen.has(id)) return 'ignored';
    this.#seen.add(id);

    this.thinking(id, '');
    this.state(id, 'received');
    if (this.#waiting) {
      this.state(id, 'failed');
      this.commentary(id, 'This request was not sent because another handoff is still waiting for the spoken words. Please repeat it.');
      return 'ignored';
    }
    const task = this.#takeTask();
    if (!task) {
      this.state(id, 'waiting');
      const timer = setTimeout(() => {
        this.#waiting = null;
        if (this.#closed) return;
        this.state(id, 'failed');
        this.commentary(id, 'The request was not sent: the spoken words did not arrive. Please repeat your request.');
      }, this.transcriptWaitMs);
      this.#waiting = { id, timer };
      return 'waiting';
    }
    return this.#deliver(id, task);
  }

  #deliver(id, task) {
    this.state(id, 'dispatching');

    if (this.#inFlight && this.steer) {
      this.#inFlight = { delegationId: id, text: task.text, startedAt: this.now() };
      this.thinking(id, 'The correction is being delivered to the active task. Do not describe the previous region as confirmed.');
      this.steer({ delegationId: id, text: task.text });
      return 'steered';
    }
    if (this.#inFlight) {
      this.#queue.push({ delegationId: id, text: task.text, raw: task.raw });
      this.log(`queued delegation ${id}: ${task.text}`);
      return 'queued';
    }
    this.#start({ delegationId: id, text: task.text, raw: task.raw });
    return 'dispatched';
  }

  #start(task) {
    this.#inFlight = { ...task, startedAt: this.now() };
    this.log(`dispatch delegation ${task.delegationId}: ${task.text}`);
    this.thinking(task.delegationId, 'The handoff is pending. Do not say the assistant accepted it until the host confirms acceptance.');
    this.dispatch(task);
  }

  /** Consume the complete buffered request, including single-word commands. */
  #takeTask() {
    const text = this.#buffer.replace(/\s+/g, ' ').trim();
    this.#buffer = '';
    return text === '' ? '' : { text, raw: text };
  }

}

/**
 * Reduce an assistant answer to something a voice model can speak.
 *
 * Commentary is spoken in the model's own words, so markdown syntax, link
 * targets, and bare paths become noise or get read out. Keep the words, drop
 * the formatting.
 * @param {string} text - Raw assistant text.
 * @returns Plain prose.
 */
export function speakable(text) {
  return String(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/gu, '$1')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*#{1,6}\s+/gmu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep a spoken result short enough for one commentary append.
 * @param {string} text
 * @param {number} [maxChars]
 */
export function summarize(text, maxChars = 1_800) {
  const flat = speakable(text);
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(boundary > maxChars * 0.5 ? cut.slice(0, boundary + 1) : cut).trim()} …`;
}
