/**
 * Live Voice — full-duplex GPT-Live session wired to this harness.
 *
 * The renderer negotiates WebRTC through the host and exchanges audio with
 * OpenAI. The host owns the API key and uses the sideband to turn delegations
 * into ordered steering messages for the current project.
 *
 * @module @rumi/live-voice
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVoiceJournal } from './journal.js';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SessionId } from '@deepseek-ai/dsh-session';
import { conversationContext, conversationText, contextChunks } from './context.js';
import { createVoiceDispatcher } from './dispatch.js';
import { createVoiceMessages } from './messages.js';
import { LiveBridge } from './bridge.js';
import { composeInstructions, createLiveVoiceRegistry } from './registry.js';
import { LiveClient } from './live-client.js';
import { DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, DEFAULT_VOICE, LIVE_ENDPOINT } from './protocol.js';

export const name = 'live-voice';
// bundle-rev: 5

export const inject = ['connection', 'sessionController', 'sessions', 'credentials'];

const ROUTE = '/api/live-voice';
const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;
const PRINT_BADGE_NAMES = new Map([
  ['barrel-hinge', 'Barrel hinge'],
  ['living-hinge', 'Living hinge'],
  ['wheel-and-axle', 'Wheel and axle'],
  ['dovetail-slide', 'Dovetail slide'],
  ['gear-pair', 'Gear pair'],
  ['rack-and-pinion', 'Rack and pinion'],
]);

/** @typedef {{liveId: string, entry?: Awaited<ReturnType<typeof createEntry>>, stopping?: Promise<void>}} VoiceReservation */

/** Configuration for one live-voice host row. */
export const Config = z.object({
  /** OpenAI API key; prefer `apiKeyFile` or `apiKeyEnv`. */
  apiKey: z.string(),
  /** Credential reference naming the key; defaults to `OPENAI_API_KEY`. */
  apiKeyEnv: z.string(),
  /** File holding the key, one line; `~` is expanded. */
  apiKeyFile: z.string(),
  /** Live session creation endpoint for a WebRTC-compatible provider. */
  endpoint: z.string(),
  /** Model name; defaults to `gpt-live-1.1`. */
  model: z.string(),
  /** Output voice; one of the Live voices. */
  voice: z.string(),
  /** Standing instructions for the voice model. */
  instructions: z.string(),
  /** Maximum characters of recent session conversation included at startup. */
  contextMaxCharacters: z.natural().min(1).max(64_000).default(16_000),
  /** Hard cap on one live session, in minutes. */
  maxSessionMinutes: z.number(),
  /** Close voice after this many minutes without user activity, once agent work settles. */
  idleTimeoutMinutes: z.number().min(1).max(60).default(DEFAULT_IDLE_TIMEOUT_MINUTES),
  /** Maximum wait for words following an early delegation. */
  transcriptWaitMs: z.natural().min(1).default(5000),
  /** Maximum time to resolve the agent and prepare reference context before submission. */
  handoffTimeoutMs: z.natural().min(1).default(10000),
  /** Delay for automatic acknowledgments, allowing host progress to suppress them. */
  acknowledgementDelayMs: z.natural().default(800),
  /** Local transcript and handoff journals, without audio or credentials. */
  diagnosticsDirectory: z.string().default(join(homedir(), '.rumi', 'voice-logs')),
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
  /** @type {VoiceReservation | undefined} */
  let reservation;
  const requests = new Set();
  const draining = new Set();
  const lifetime = new AbortController();
  ctx.effect(() => async () => {
    lifetime.abort();
    await stop(reservation?.liveId);
    await Promise.allSettled([...requests]);
    await Promise.allSettled([...draining]);
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
    const current = reservation;
    if (!current?.entry || current.liveId !== liveId) return;
    if (current.stopping) return current.stopping;
    // Keep the slot until the provider transport closes. Already-submitted
    // project work can finish independently, and disposal still awaits it.
    current.stopping = current.entry.closeTransport().finally(() => { reservation = undefined; });
    const drained = current.entry.drain();
    draining.add(drained);
    void drained.then(() => draining.delete(drained));
    return current.stopping;
  };

  ctx.inject(['rumiProjectScope'], scoped => {
    scoped.on('rumi/print-badge-earned', ({ projectPath, awards }) => {
      const current = reservation;
      if (!current?.entry || current.stopping || lifetime.signal.aborted) return;
      current.entry.noteBadges(scoped.rumiProjectScope, projectPath, awards);
    });
  });

  register('/session', ['POST'], async (request) => {
    const body = await readJson(request);
    const sessionId = body?.sessionId;
    const sdp = body?.sdp;
    if (typeof sessionId !== 'string' || sessionId === '') return json({ error: 'live voice: no session id' }, 400);
    if (typeof sdp !== 'string' || sdp.length > 65_536 || !sdp.startsWith('v=0')) {
      return json({ error: 'Live Voice requires a WebRTC offer.' }, 400);
    }
    if (reservation) {
      return json({ code: 'voice_busy', error: 'Live Voice is already in use. End that session or wait for it to close, then try again.' }, 409);
    }
    /** @type {VoiceReservation} */
    const current = { liveId: randomUUID() };
    reservation = current;
    try {
      lifetime.signal.throwIfAborted();
      const apiKey = await resolveApiKey(ctx, config);
      debugLog(config, `start session=${sessionId} key=${apiKey ? 'yes' : 'no'}`);
      if (!apiKey) return json({ error: `live voice: no OpenAI API key in ${config.apiKeyEnv ?? 'OPENAI_API_KEY'}` }, 503);
      const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId));
      if ('error' in resolved) return json({ error: resolved.error.message }, 404);
      const session = resolved.agent.session;
      const instructions = await compose(sessionId);
      lifetime.signal.throwIfAborted();
      const { liveId } = current;
      const entry = await createEntry({ ctx, registry, config, logger, apiKey, sdp, sessionId, liveId, instructions, session, agent: resolved.agent, signal: lifetime.signal, onClosed: () => stop(liveId) });
      if (lifetime.signal.aborted || entry.closed) {
        await Promise.all([entry.closeTransport(), entry.drain()]);
        return json({ error: 'live voice: stopped' }, 503);
      }
      current.entry = entry;
      return json({ liveId, sdp: entry.answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, `start-failed session=${sessionId} ${message}`);
      return json({ error: message }, 502);
    } finally {
      if (!current.entry) reservation = undefined;
    }
  });

  register('/poll', ['POST'], async (request) => {
    const body = await readJson(request);
    const current = reservation;
    const entry = current && current.liveId === body?.liveId ? current.entry : undefined;
    if (!entry) return json({ error: 'live voice: unknown session', closed: true }, 404);
    return json(await entry.poll(5_000));
  });

  register('/close', ['POST'], async (request) => {
    const body = await readJson(request);
    debugLog(config, `close requested reason=${body?.reason ?? 'user'}`);
    if (typeof body?.liveId === 'string') await stop(body.liveId);
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

/** Allow a pending voice reply to start and leave time for buffered audio to play. */
const VOICE_REPLY_GRACE_MS = 5_000;

/** Report audible output while ignoring silence reflected by the sideband. */
function hasSpeechAudio(delta) {
  if (typeof delta !== 'string' || delta === '') return false;
  const pcm = Buffer.from(delta, 'base64');
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= 256) return true;
  }
  return false;
}

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
 * One live session: the GPT-Live sideband, the bridge, and the event queue the
 * browser polls.
 */
async function createEntry({ ctx, registry, config, logger, apiKey, sdp, sessionId, liveId, instructions, session, agent, signal, onClosed }) {
  const endpoint = new URL(config.endpoint ?? LIVE_ENDPOINT);
  const model = config.model ?? DEFAULT_MODEL;
  const journal = createVoiceJournal(expandHome(config.diagnosticsDirectory ?? join(homedir(), '.rumi', 'voice-logs')), { sessionId, liveId }, error => {
    push({ type: 'error', message: `Voice diagnostics could not be saved: ${error.message}` });
    end('diagnostics_failed');
  });
  const queue = [];
  let waiter = null;
  let isClosed = false;
  let lastSpeakingAt = -Infinity;
  let cap;
  let idleTimer;
  const idleTimeoutMs = (config.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60_000;
  let lastUserActivityAt = Date.now();
  let voiceReplyUntil = 0;
  let agentRunning = agent.status === 'running';
  let stopStatus = () => {};
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

  const scheduleIdleClose = () => {
    clearTimeout(idleTimer);
    if (isClosed || agentRunning || turns.size > 0 || bridge.busy || bridge.snapshot().waitingForTranscript) return;
    const deadline = Math.max(lastUserActivityAt + idleTimeoutMs, voiceReplyUntil);
    idleTimer = setTimeout(() => end('idle_timeout'), Math.max(0, deadline - Date.now()));
    idleTimer.unref?.();
  };

  const noteUserActivity = () => {
    lastUserActivityAt = Date.now();
    scheduleIdleClose();
  };

  const allowVoiceReply = () => {
    voiceReplyUntil = Date.now() + VOICE_REPLY_GRACE_MS;
    scheduleIdleClose();
  };

  const handoff = (delegationId, state, detail = null) => {
    journal.record('handoff', { delegationId, state, detail });
    if (!isClosed) push({ type: 'handoff', delegationId, state });
    scheduleIdleClose();
  };
  let speechContext = null;
  const speechLifetime = new AbortController();
  const submit = createVoiceDispatcher({
    resolveAgent: async () => {
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) throw new Error(resolved.error?.message ?? 'session unavailable');
      return resolved.agent;
    },
    createMessages: createVoiceMessages,
    timeoutMs: config.handoffTimeoutMs ?? 10000,
    accepted: delegationId => {
      handoff(delegationId, 'accepted');
      const content = 'The modeling assistant has accepted the request into its inbox. Work is not yet complete. Do not claim a highlight is visible until the viewer reports rendered.';
      journal.record('host.thinking', { delegationId, content });
      live.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
    },
    failed: (delegationId, detail) => handoff(delegationId, 'failed', detail),
    flush: session => ctx.sessions.flush(session), outcome: readOutcome,
    finished: result => bridge.turnFinished(result), closed: () => bridge.closed,
  });
  const dispatch = task => {
    const content = speechContext ?? Promise.resolve([]);
    speechContext = null;
    const turn = submit({ ...task, content });
    turns.add(turn);
    scheduleIdleClose();
    void turn.then(() => { turns.delete(turn); scheduleIdleClose(); });
  };
  const bridge = new LiveBridge({
    dispatch, steer: dispatch,
    transcriptWaitMs: config.transcriptWaitMs ?? 5000,
    state: handoff,
    commentary: (delegationId, content) => {
      journal.record('host.commentary', { delegationId, content });
      live.send({ type: 'session.commentary.append', event_id: randomUUID(), delegation_id: delegationId, content });
      push({ type: 'transcript', role: 'assistant', text: content });
      allowVoiceReply();
    },
    thinking: (delegationId, content) => {
      journal.record('host.thinking', { delegationId, content });
      live.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: delegationId, content });
    },
    log: (message) => logger.info(message),
  });

  const live = new LiveClient({
    apiKey,
    endpoint: endpoint.href,
    model,
    voice: config.voice ?? DEFAULT_VOICE,
    acknowledgementDelayMs: config.acknowledgementDelayMs ?? 800,
    instructions: `${instructions}\n\n${conversationContext(session, config.contextMaxCharacters ?? 16_000)}`,
    onEvent: (event) => {
      if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
        journal.record(event.type, { delta: event.delta, start_ms: event.start_ms ?? null, end_ms: event.end_ms ?? null });
      } else if (event.type === 'session.delegation.created') {
        journal.record(event.type, { id: event.delegation?.id ?? null, target: event.delegation?.target ?? null, offset_ms: event.offset_ms ?? null });
      } else if (event.type === 'session.thinking.appended') {
        journal.record(event.type, { client_event_id: event.client_event_id ?? null });
      }
      if (event.type === 'session.output_audio.delta') {
        // Keep the speaking indicator responsive without polling for every media frame.
        const now = Date.now();
        if (now - lastSpeakingAt >= 250 && hasSpeechAudio(event.delta)) {
          lastSpeakingAt = now;
          allowVoiceReply();
          push({ type: 'speaking' });
        }
      } else if (event.type === 'session.input_transcript.delta') {
        if (typeof event.delta === 'string' && event.delta.trim()) noteUserActivity();
        if (!speechContext && typeof event.delta === 'string' && event.delta.trim()) {
          if (!bridge.busy && !bridge.snapshot().waitingForTranscript) handoff(null, 'not_sent');
          const requestedAt = new Date().toISOString();
          speechContext = Promise.all(registry.contributors().map(async contributor => {
            if (!contributor.captureRequest) return [];
            try { return await contributor.captureRequest({ sessionId, requestedAt, signal: speechLifetime.signal }); }
            catch (error) {
              logger.warn(`Voice reference capture failed: ${contributor.id}`);
              return [{ type: 'text', text: 'The visual reference for this spoken request could not be captured. Ask for a fresh pointing reference; do not guess.' }];
            }
          })).then(parts => parts.flat());
        }
        push({ type: 'transcript', role: 'user', text: event.delta });
      } else if (event.type === 'session.output_transcript.delta') {
        push({ type: 'transcript', role: 'assistant', text: event.delta });
      } else if (event.type === 'session.closed') {
        debugLog(config, `session-closed reason=${event.reason}`);
        end(event.reason ?? 'server_closed');
      } else if (event.type === 'error') {
        journal.record('transport.error', { code: event.error?.code ?? null, message: event.error?.message ?? 'live error' });
        push({ type: 'error', message: event.error?.message ?? 'live error' });
      }
      bridge.handleLiveEvent(event);
      if (event.type === 'session.delegation.created') scheduleIdleClose();
    },
    onClose: (detail) => {
      end('socket_closed');
      debugLog(config, `socket-closed code=${detail?.code ?? '-'} reason=${detail?.reason || '-'}`);

    },
    onError: (error) => { journal.record('transport.error', { message: error.message }); push({ type: 'error', message: error.message }); },
  });

  const end = (reason, notifyHost = true) => {
    if (isClosed) return;
    isClosed = true;
    journal.record('closed', { reason });
    journal.close();
    bridge.close();
    speechLifetime.abort();
    stopNarration();
    stopContext();
    stopStatus();
    clearTimeout(idleTimer);
    pendingContext.length = 0;
    clearTimeout(cap);
    signal.removeEventListener('abort', abort);
    void live.close();
    push({ type: 'closed', reason });
    if (notifyHost) onClosed();
  };
  const abort = () => end('plugin_disposed');
  // Subscribe in the same synchronous acquisition as the history snapshot so no
  // committed messages are lost during negotiation.
  stopContext = ctx.on('session/event', (changed, event) => {
    if (isClosed || changed.id !== sessionId) return;
    const message = event.type === 'user/message' ? event.data
      : event.type === 'assistant/message' ? event.data.message : null;
    if (message === null) return;
    if (event.type === 'user/message' && event.data.source.kind === 'user') noteUserActivity();
    for (const content of contextChunks(conversationText(message))) {
      const frame = { type: 'session.thinking.append', delegation_id: null, content };
      if (live.open) live.send(frame);
      else pendingContext.push(frame);
    }
  });
  stopStatus = ctx.on('api-session/status', (changedId, running) => {
    if (changedId !== sessionId || isClosed) return;
    agentRunning = running;
    scheduleIdleClose();
  });
  signal.addEventListener('abort', abort, { once: true });
  let answer;
  try {
    signal.throwIfAborted();
    journal.record('opened', { model });
    if (isClosed) throw new Error('Voice diagnostics could not be saved');
    answer = await live.connect(sdp, signal);
    signal.throwIfAborted();
    if (isClosed) throw new Error('live voice: session closed during startup');
  } catch (error) {
    end('start_failed');
    await live.close();
    throw error;
  }
  for (const frame of pendingContext.splice(0)) live.send(frame);
  push({ type: 'ready', model });

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
    journal.record('host.progress', { delegationId: currentDelegation(), content });
    live.send({ type: 'session.thinking.append', event_id: randomUUID(), delegation_id: currentDelegation(), content });
  };

  stopNarration = narrate(ctx, sessionId, noteProgress);

  cap = setTimeout(() => end('max_session_minutes'), (config.maxSessionMinutes ?? 60) * 60_000);
  cap.unref?.();
  noteUserActivity();

  return {
    get closed() { return isClosed; },
    answer,
    noteBadges(scope, projectPath, awards) {
      if (isClosed || !live.open) return;
      let root;
      try { root = scope.rootFor(session); }
      catch (_unregisteredSession) {
        // Voice can be open while its project is removed or its chat is detached.
        return;
      }
      if (root !== projectPath) return;
      const names = awards.map(award => PRINT_BADGE_NAMES.get(award.kind)).filter(Boolean);
      if (names.length === 0) return;
      const awardNote = names.length === 1
        ? `The user just earned the ${names[0]} badge in this project.`
        : `The user just earned these badges in this project. ${names.join(', ')}.`;
      const content = `${awardNote} You may mention this briefly in your next relevant reply, in the user's language. Wait for a normal chance to speak. Print readiness requires a separate check.`;
      const eventId = randomUUID();
      journal.record('host.thinking', { delegationId: null, eventId, awardIds: awards.map(award => award.id), content });
      if (!isClosed) live.send({ type: 'session.thinking.append', event_id: eventId, delegation_id: null, content });
    },
    closeTransport() {
      end('close_requested', false);
      return live.close();
    },
    drain() {
      return Promise.allSettled([...turns]);
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
