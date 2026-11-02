/**
 * Live Voice — full-duplex GPT-Live session wired to this harness.
 *
 * The browser half carries microphone audio and playback; this host half holds
 * the OpenAI key, speaks the Live protocol, and turns each GPT-Live delegation
 * into one harness turn. Results are appended back to the live session against
 * the delegation id that asked for them.
 *
 * The browser transport is the shared `/api` Fetch channel, not a WebSocket:
 * the desktop app runs the page on `dsh-app://app` and proxies `/api` requests
 * (with the auth cookie) to the host, so relative Fetch paths are the only
 * origin-agnostic way to reach this process.
 *
 * @module @rumi/live-voice
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SessionId } from '@deepseek-ai/dsh-session';
import { conversationContext, conversationText, contextChunks } from './context.js';
import { LiveBridge } from './bridge.js';
import { composeInstructions, createLiveVoiceRegistry } from './registry.js';
import { LiveClient } from './live-client.js';
import { DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, DEFAULT_VOICE, LIVE_ENDPOINT } from './protocol.js';

export const name = 'live-voice';
// bundle-rev: 2

export const inject = ['connection', 'sessionController', 'sessions', 'credentials'];

const ROUTE = '/api/live-voice';

/** Configuration for one live-voice host row. */
export const Config = z.object({
  /** OpenAI API key; prefer `apiKeyFile` or `apiKeyEnv`. */
  apiKey: z.string(),
  /** Credential reference naming the key; defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: z.string(),
  /** File holding the key, one line; `~` is expanded. */
  apiKeyFile: z.string(),
  /** Live WebSocket endpoint; override for Microsoft Foundry or a test server. */
  endpoint: z.string(),
  /** Model name; defaults to `gpt-live-1`. */
  model: z.string(),
  /** Output voice; one of the Live voices. */
  voice: z.string(),
  /** Standing instructions for the voice model. */
  instructions: z.string(),
  /** Maximum characters of recent session conversation included at startup. */
  contextMaxCharacters: z.natural().min(1).max(64_000).default(16_000),
  /** Hard cap on one live session, in minutes. */
  maxSessionMinutes: z.number(),
  /** Append transport diagnostics to this file; `~` is expanded. */
  logFile: z.string(),
});

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const logger = {
    info: (message) => console.log(`[live-voice] ${message}`),
    warn: (message) => console.warn(`[live-voice] ${message}`),
  };
  /** @type {Map<string, any>} */
  const liveSessions = new Map();
  /** @type {Map<string, string>} One live session per DSH session, at most. */
  const liveIdBySession = new Map();
  const starting = new Set();
  const requests = new Set();
  const closing = new Set();
  const lifetime = new AbortController();
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.all([...liveSessions.keys()].map(stop));
    await Promise.allSettled([...requests]);
    await Promise.allSettled([...closing]);
  }, 'live-voice sessions');


  const registry = createLiveVoiceRegistry();
  ctx.provide('liveVoice', registry);

  const compose = (sessionId) => composeInstructions({
    base: config.instructions ?? DEFAULT_INSTRUCTIONS,
    contributors: registry.contributors(),
    sessionId,
    onError: (id, error) => logger.warn(`live voice: ${id} instructions failed: ${error instanceof Error ? error.message : String(error)}`),
  });

  const register = (path, methods, fetch) => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: `${ROUTE}${path}`,
        methods,
        requestBody: 'buffered',
        fetch(request) {
          if (lifetime.signal.aborted) return json({ error: 'live voice: stopped' }, 503);
          const task = Promise.resolve().then(() => fetch(request));
          requests.add(task);
          void task.then(() => requests.delete(task), () => requests.delete(task));
          return task;
        },
      }),
      `live-voice: ${ROUTE}${path}`,
    );
  };

  const stop = (liveId) => {
    const entry = liveSessions.get(liveId);
    if (!entry) return;
    // Drop the entry first: closing it reports back through `onClosed`, which
    // calls this again, and a live entry here would recurse.
    liveSessions.delete(liveId);
    if (liveIdBySession.get(entry.sessionId) === liveId) liveIdBySession.delete(entry.sessionId);
    const task = entry.close();
    closing.add(task);
    void task.then(() => closing.delete(task), () => closing.delete(task));
    return task;
  };

  register('/session', ['POST'], async (request) => {
    const body = await readJson(request);
    const sessionId = body?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') return json({ error: 'live voice: no session id' }, 400);
    if (starting.has(sessionId)) return json({ error: 'live voice: session is starting' }, 409);
    starting.add(sessionId);
    try {
      const apiKey = await resolveApiKey(ctx, config);
      debugLog(config, `start session=${sessionId} key=${apiKey ? 'yes' : 'no'}`);
      if (!apiKey) return json({ error: `live voice: no OpenAI API key in ${config.apiKeyEnv ?? 'OPENAI_API_KEY'}` }, 503);
      // One live session per Session: a second start replaces the first rather
      // than leaving two sockets appending into the same conversation.
      const existing = liveIdBySession.get(sessionId);
      if (existing !== undefined) {
        debugLog(config, `replacing live session ${existing} for session=${sessionId}`);
        await stop(existing);
      }
      const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId));
      if ('error' in resolved) return json({ error: resolved.error.message }, 404);
      const session = resolved.agent.session;
      const instructions = await compose(sessionId);
      lifetime.signal.throwIfAborted();
      const liveId = randomUUID();
      const entry = await createEntry({ ctx, config, logger, apiKey, sessionId, liveId, instructions, session, signal: lifetime.signal, onClosed: () => stop(liveId) });
      if (lifetime.signal.aborted || entry.closed) {
        await entry.close();
        return json({ error: 'live voice: stopped' }, 503);
      }
      liveSessions.set(liveId, entry);
      liveIdBySession.set(sessionId, liveId);
      return json({ liveId, model: config.model ?? DEFAULT_MODEL, voice: config.voice ?? DEFAULT_VOICE });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, `start-failed session=${sessionId} ${message}`);
      return json({ error: message }, 502);
    } finally {
      starting.delete(sessionId);
    }
  });

  register('/audio', ['POST'], async (request) => {
    const body = await readJson(request);
    const entry = liveSessions.get(body?.liveId);
    if (!entry) return json({ error: 'live voice: unknown session' }, 404);
    if (typeof body.data === 'string') entry.sendAudio(body.data);
    return new Response(null, { status: 204 });
  });

  register('/poll', ['POST'], async (request) => {
    const body = await readJson(request);
    const entry = liveSessions.get(body?.liveId);
    if (!entry) return json({ error: 'live voice: unknown session', closed: true }, 404);
    return json(await entry.poll(5_000));
  });

  register('/close', ['POST'], async (request) => {
    const body = await readJson(request);
    debugLog(config, `close requested reason=${body?.reason ?? 'user'}`);
    if (typeof body?.liveId === 'string') await stop(body.liveId);
    return new Response(null, { status: 204 });
  });

  register('/mute', ['POST'], async (request) => {
    const body = await readJson(request);
    const entry = liveSessions.get(body?.liveId);
    if (!entry) return json({ error: 'live voice: unknown session' }, 404);
    entry.mute(body?.muted !== false);
    return new Response(null, { status: 204 });
  });

  register('/settings', ['GET', 'POST'], async (request) => {
    if (request.method === 'POST') {
      const body = await readJson(request);
      const candidate = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
      if (candidate === '') return json({ error: 'live voice: empty key' }, 400);
      try {
        await ctx.credentials.set(credentialRef(config.apiKeyEnv ?? 'OPENAI_API_KEY'), candidate);
        debugLog(config, 'settings key saved from the UI');
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    const key = await resolveApiKey(ctx, config);
    return json({
      hasKey: Boolean(key),
      hint: key === undefined ? '' : key.length < 12 ? '••••' : `${key.slice(0, 7)}…${key.slice(-4)}`,
      file: '~/.rumi/.credentials.yaml',
    });
  });
}

/** Shortest gap between two progress notes, so a busy turn stays quiet. */
const NARRATION_INTERVAL_MS = 4_000;

/**
 * Follow one Session's activity and report it as quiet progress.
 *
 * Only tool calls are narrated, and only one every few seconds: the point is a
 * voice that is not silent for minutes, not a transcript. Notes go through
 * `thinking`, so the model can follow along without speaking them.
 * @param {object} ctx - host plugin context.
 * @param {string} sessionId - Session to follow.
 * @param {(content: string) => void} note - Sends one thinking note.
 * @returns {() => void} Stops the subscription.
 */
function narrate(ctx, sessionId, note) {
  let lastAt = 0;
  let lastTool = '';
  const stop = ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return;
    if (event.type !== 'tool/call') return;
    const tool = event.data?.name;
    if (typeof tool !== 'string' || tool === '') return;
    const now = Date.now();
    if (tool === lastTool && now - lastAt < NARRATION_INTERVAL_MS * 4) return;
    if (now - lastAt < NARRATION_INTERVAL_MS) return;
    lastAt = now;
    lastTool = tool;
    note(`The harness is using ${tool}.`);
  });
  return typeof stop === 'function' ? stop : () => {};
}

/**
 * One live session: the GPT-Live socket, the bridge, and the event queue the
 * browser polls.
 */
async function createEntry({ ctx, config, logger, apiKey, sessionId, liveId, instructions, session, signal, onClosed }) {
  const queue = [];
  let waiter = null;
  let isClosed = false;
  let muted = false;
  let cap;
  const turns = new Set();
  /** Stop the session-event narration; runs before the socket closes. */
  let stopNarration = () => {};
  let stopContext = () => {};
  const pendingContext = [];

  const push = (message) => {
    queue.push(message);
    waiter?.();
    waiter = null;
  };

  const bridge = new LiveBridge({
    dispatch: (task) => {
      push({ type: 'status', state: 'thinking', detail: task.text });
      const turn = runHarnessTurn(ctx, sessionId, task, bridge, logger);
      turns.add(turn);
      void turn.then(() => turns.delete(turn));
    },
    commentary: (delegationId, content) => {
      live.send({ type: 'session.commentary.append', delegation_id: delegationId, content });
      push({ type: 'transcript', role: 'assistant', text: content });
    },
    thinking: (delegationId, content) => {
      live.send({ type: 'session.thinking.append', delegation_id: delegationId, content });
    },
    log: (message) => logger.info(message),
  });

  const live = new LiveClient({
    apiKey,
    url: config.endpoint ?? LIVE_ENDPOINT,
    model: config.model ?? DEFAULT_MODEL,
    voice: config.voice ?? DEFAULT_VOICE,
    instructions: `${instructions}\n\n${conversationContext(session, config.contextMaxCharacters ?? 16_000)}`,
    onEvent: (event) => {
      if (event.type === 'session.output_audio.delta') {
        push({ type: 'audio', data: event.delta });
      } else if (event.type === 'session.input_transcript.delta') {
        push({ type: 'transcript', role: 'user', text: event.delta });
      } else if (event.type === 'session.output_transcript.delta') {
        push({ type: 'transcript', role: 'assistant', text: event.delta });
      } else if (event.type === 'session.closed') {
        debugLog(config, `session-closed reason=${event.reason}`);
        end(event.reason ?? 'server_closed');
      } else if (event.type === 'session.input_audio.muted' || event.type === 'session.input_audio.unmuted') {
        muted = event.type === 'session.input_audio.muted';
        push({ type: 'muted', muted });
      } else if (event.type === 'error') {
        push({ type: 'error', message: event.error?.message ?? 'live error' });
      }
      bridge.handleLiveEvent(event);
    },
    onClose: (detail) => {
      end('socket_closed');
      debugLog(config, `socket-closed code=${detail?.code ?? '-'} reason=${detail?.reason || '-'}`);

    },
    onError: (error) => push({ type: 'error', message: error.message }),
  });

  const end = (reason) => {
    if (isClosed) return;
    isClosed = true;
    bridge.close();
    stopNarration();
    stopContext();
    pendingContext.length = 0;
    clearTimeout(cap);
    signal.removeEventListener('abort', abort);
    void live.close();
    push({ type: 'closed', reason });
    onClosed?.();
  };
  const abort = () => end('plugin_disposed');
  // Subscribe in the same synchronous acquisition as the history snapshot so no
  // committed messages are lost while the WebSocket handshake is pending.
  stopContext = ctx.on('session/event', (changed, event) => {
    if (isClosed || changed.id !== sessionId) return;
    const message = event.type === 'user/message' ? event.data
      : event.type === 'assistant/message' ? event.data.message : null;
    if (message === null) return;
    for (const content of contextChunks(conversationText(message))) {
      const frame = { type: 'session.thinking.append', delegation_id: null, content };
      if (live.open) live.send(frame);
      else pendingContext.push(frame);
    }
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await live.connect();
    signal.throwIfAborted();
    if (isClosed) throw new Error('live voice: session closed during startup');
  } catch (error) {
    end('start_failed');
    await live.close();
    throw error;
  }
  for (const frame of pendingContext.splice(0)) live.send(frame);
  push({ type: 'ready', model: config.model ?? DEFAULT_MODEL, voice: config.voice ?? DEFAULT_VOICE });

  /** The delegation whose work is running, or null between tasks. */
  const currentDelegation = () => bridge.snapshot().inFlight?.delegationId ?? null;

  /**
   * Tell the voice model what the harness is doing without asking it to say it.
   *
   * These are `thinking` notes, so the model can follow along silently; the
   * spoken answer arrives later as commentary.
   */
  const noteProgress = (content) => {
    if (content === '') return;
    live.send({ type: 'session.thinking.append', delegation_id: currentDelegation(), content });
  };

  stopNarration = narrate(ctx, sessionId, noteProgress);

  cap = setTimeout(() => end('max_session_minutes'), (config.maxSessionMinutes ?? 60) * 60_000);
  cap.unref?.();

  return {
    sessionId,
    liveId,
    get closed() { return isClosed; },
    sendAudio: (data) => live.sendAudio(data),
    /** Mute or unmute caller audio on the wire; the server confirms with an event. */
    mute(next) {
      if (next === muted) return;
      live.send({ type: next ? 'session.input_audio.mute' : 'session.input_audio.unmute' });
    },
    async close() {
      end('close_requested');
      await live.close();
      await Promise.allSettled([...turns]);
    },
    /** Return everything queued, waiting up to `timeoutMs` for the first item. */
    async poll(timeoutMs) {
      if (queue.length === 0 && !isClosed) {
        await new Promise((resolve) => {
          const timer = setTimeout(finish, timeoutMs);
          timer.unref?.();
          function finish() {
            clearTimeout(timer);
            if (waiter === finish) waiter = null;
            resolve();
          }
          waiter = finish;
        });
      }
      const events = queue.splice(0, queue.length);
      return { events, closed: isClosed };
    },
  };
}

/**
 * One task runs as one follow-up turn in the attached harness session. The
 * turn's final assistant text is the answer spoken back to the caller.
 */
async function runHarnessTurn(ctx, sessionId, task, bridge, logger) {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const resolved = await ctx.sessionController.resolveAgent(sessionId);
    if (resolved && 'error' in resolved) {
      bridge.turnFinished({ ok: false, text: resolved.error?.message ?? 'session unavailable' });
      return;
    }
    if (bridge.closed) return;
    const agent = resolved.agent;
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task.text }],
      // A spoken request is the user's own message: recording it as one makes
      // the transcript show the words in a normal user bubble, and the next
      // dictation replaces the preview that showed the same text.
      source: { kind: 'user' },
    }));
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    const outcome = readOutcome(agent.session, firstSeq);
    bridge.turnFinished({ ok: outcome.reason?.kind !== 'error', text: outcome.text });
  } catch (error) {
    logger.warn(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    bridge.turnFinished({ ok: false, text: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Read the assistant text and turn outcome produced after `firstSeq`.
 * Mirrors the headless runner's summary of the durable session log.
 */
export function readOutcome(session, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  const length = session.seq;
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq);
    if (event === undefined) break;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

/**
 * Resolve saved credentials first, then explicit configuration, a legacy key
 * file, and the launch environment. Credential failures are reported to callers.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export async function resolveApiKey(ctx, config) {
  const ref = config.apiKeyEnv ?? 'OPENAI_API_KEY';
  const stored = await ctx.credentials.resolve(credentialRef(ref));
  if (stored?.value) return stored.value;
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyFile) {
    const fromFile = readKeyFile(config.apiKeyFile);
    if (fromFile) return fromFile;
  }
  try {
    const ambient = launchEnvironmentOf(ctx).get(ref);
    if (ambient?.value) return ambient.value;
  } catch {
    // no launcher snapshot; read the process environment directly
  }
  return process.env[ref] || undefined;
}

function expandHome(path) {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/** Read a one-line key file; absent or unreadable reads as no key. */
export function readKeyFile(path) {
  try {
    return readFileSync(expandHome(path), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function debugLog(config, line) {
  if (!config.logFile) return;
  try {
    appendFileSync(expandHome(config.logFile), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // diagnostics must never break the route
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
