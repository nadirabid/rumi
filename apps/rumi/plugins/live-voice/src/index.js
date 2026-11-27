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
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SessionId } from '@deepseek-ai/dsh-session';
import { composeInstructions, createLiveVoiceRegistry } from './registry.js';
import { DEFAULT_INSTRUCTIONS } from './protocol.js';
import { createEntry, DEFAULT_IDLE_TIMEOUT_MINUTES } from './session-entry.js';

export const name = 'live-voice';
// bundle-rev: 5

export const inject = ['connection', 'sessionController', 'sessions', 'credentials'];

const ROUTE = '/api/live-voice';

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
      const entry = await createEntry({
        ctx, registry, config, logger, apiKey, sdp, sessionId, liveId, instructions,
        session, agent: resolved.agent, signal: lifetime.signal, onClosed: () => stop(liveId),
        expandHome, debugLog, readOutcome,
      });
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
