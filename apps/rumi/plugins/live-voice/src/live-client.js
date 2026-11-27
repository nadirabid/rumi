/** OpenAI WebRTC negotiation and host-side control for one Live session. */

import WebSocket from 'ws';
import { parseEvent, sessionConfig } from './protocol.js';

const START_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * Keep the credential, instructions, and project-agent controls on the host.
 * The renderer receives only the negotiated SDP answer and Rumi's session ID.
 */
export class LiveClient {
  #socket = null;
  #closed = false;
  #closing = null;

  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.endpoint Live session creation URL.
   * @param {string} options.model
   * @param {string} options.instructions
   * @param {string} options.voice
   * @param {number} options.acknowledgementDelayMs
   * @param {(event: any) => void} options.onEvent
   * @param {(error: Error) => void} options.onError
   * @param {(detail: {code: number, reason: string}) => void} options.onClose
   */
  constructor({ apiKey, endpoint, model, instructions, voice, acknowledgementDelayMs, onEvent, onError, onClose }) {
    this.headers = { Authorization: `Bearer ${apiKey}` };
    this.endpoint = new URL(endpoint);
    // Profiles can retain a WebSocket URL if the provider also implements WebRTC.
    if (this.endpoint.protocol === 'wss:') this.endpoint.protocol = 'https:';
    if (this.endpoint.protocol === 'ws:') this.endpoint.protocol = 'http:';
    this.session = sessionConfig({ model, instructions, voice, acknowledgementDelayMs });
    this.onEvent = onEvent;
    this.onError = onError;
    this.onClose = onClose;
  }

  get open() {
    return !this.#closed && this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Create the WebRTC session and attach host controls before enabling caller audio.
   * @param {string} sdp Renderer SDP offer.
   * @param {AbortSignal} signal Host lifetime.
   * @returns {Promise<string>} OpenAI SDP answer.
   */
  async connect(sdp, signal) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: this.session, transport: { type: 'webrtc', sdp } }),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(START_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenAI could not start Live Voice (HTTP ${response.status}). Check your API key and GPT-Live access, then try again.`);
    }
    const result = await response.json();
    const id = result?.session?.id;
    const answer = result?.transport?.sdp;
    if (typeof id !== 'string' || !/^live_[A-Za-z0-9_-]+$/u.test(id)) {
      throw new Error('OpenAI did not return a valid Live Voice session ID.');
    }
    signal.throwIfAborted();
    if (this.#closed) throw new Error('Live Voice closed during setup.');
    const sideband = new URL(this.endpoint);
    sideband.protocol = this.endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    sideband.pathname = `${sideband.pathname.replace(/\/$/u, '')}/${id}/attach`;
    await this.#attach(sideband);
    if (result.transport?.type !== 'webrtc' || typeof answer !== 'string' || answer === '') {
      throw new Error('OpenAI did not return a valid WebRTC answer.');
    }
    return answer;
  }

  #attach(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: this.headers, handshakeTimeout: START_TIMEOUT_MS });
      this.#socket = socket;
      let opened = false;
      socket.once('open', () => {
        opened = true;
        resolve();
      });
      socket.on('message', (raw) => {
        const event = parseEvent(raw);
        if (event && !this.#closed) this.onEvent(event);
      });
      socket.on('error', (error) => {
        if (!opened) reject(error);
        else if (!this.#closed) this.onError(error);
      });
      socket.once('close', (code, reason) => {
        if (!opened) reject(new Error('Live Voice controls disconnected during setup.'));
        else if (!this.#closed) this.onClose({ code, reason: reason.toString() });
      });
    });
  }

  /**
   * @param {object} event Live control event.
   * @returns {boolean} Whether the sideband accepted the send.
   */
  send(event) {
    if (!this.open) return false;
    this.#socket.send(JSON.stringify(event));
    return true;
  }

  /**
   * End the provider session and release the sideband within a bounded time.
   * @returns {Promise<void>} Settles when the socket closes.
   */
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.#closing = new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        socket.terminate();
      };
      const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
      timer.unref?.();
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (socket.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      socket.on('message', (raw) => {
        if (parseEvent(raw)?.type === 'session.closed') finish();
      });
      socket.send(JSON.stringify({ type: 'session.close' }), error => { if (error) finish(); });
    });
    return this.#closing;
  }
}
