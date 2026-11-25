/** Review Print Studio steps through one shared Bison request slot. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { discoverModels } from './viewer/catalog.js'
import { MAX_REGION_MAP_BYTES, needsSurfaceRegions, readModelRegions } from './viewer/model-regions.js'
import { USD_MAX_BYTES } from './viewer/usd.js'

const endpoint = 'https://inference.baseten.co/v1/systemone'
const model = 'decision-models/baseten-bison-latest'
const questions = {
  namedRegions: {
    type: 'noul',
    instructions: 'Does the agent need a reminder to finish naming features on the final saved mesh? Review models and maps created or revised this turn. When the agent is wrapping up, remind it about missing, invalid, or outdated maps. For needs_surface_regions, remind it to identify physical features on the mesh when creating or refreshing names. A request specifically about empty space can use a volume alone. Keep observing while the agent is still working.',
  },
  conciseReply: {
    type: 'noul',
    instructions: 'Would reminding the agent to follow Rumi reply guidance help at this point in the turn? Judge the visible draft in the context of the current request and work. An empty draft warrants no reminder. For a child asking to make, check, or fix something, aim for under 35 words and at most two short sentences. Preserve requested detail and safety information.',
  },
}

const MAX_ACTIONS = 16
const MAX_PLAN_ITEMS = 8
const MAX_LABEL_CHARS = 160
const MAX_TOOL_JSON_CHARS = 65_536
const checkCount = Object.keys(questions).length

const text = (message, limit) => (message?.content ?? [])
  .filter(block => block.type === 'text')
  .map(block => block.text.slice(0, limit))
  .join('\n').slice(0, limit)

function parseToolJson(value) {
  if (value.length > MAX_TOOL_JSON_CHARS) return null
  try {
    return JSON.parse(value)
  } catch (_error) {
    return null
  }
}

function describeToolCall({ name, arguments: raw, step }) {
  const action = { step, tool: name.slice(0, 64), outcome: 'pending' }
  if (name !== 'bash' && name !== 'skill') return action
  const args = parseToolJson(raw)
  if (name === 'bash' && typeof args?.description === 'string') {
    action.description = args.description.slice(0, MAX_LABEL_CHARS)
  }
  if (name === 'skill' && typeof args?.name === 'string' && /^[a-z0-9-]{1,64}$/u.test(args.name)) {
    action.skill = args.name
  }
  return action
}

function recordToolOutcome(action, message) {
  action.outcome = message.isError ? 'failed' : 'completed'
  if (message.isError || action.tool !== 'bash') return
  const output = message.content.find(block => block.type === 'text')?.text ?? ''
  const tail = output.slice(-4096)
  const exitMarker = /\n\[(?:exit code: 0*[1-9]\d*|killed by signal: [^\]\n]+)\]$/u
  if (exitMarker.test(tail) || /(?:^|\n)\[(?:timed out after |stopped: )/u.test(tail)) action.outcome = 'failed'
  if (output.startsWith('started background job ') || tail.includes('[still running after ')) action.outcome = 'background'
  const match = /(?:^|\n)RUMI_CHECKS (\{[^\n]{1,65536}\})/u.exec(output)
  if (match) {
    const report = parseToolJson(match[1])
    if (['passed', 'needs_repair', 'unavailable'].includes(report?.status)) action.geometryCheck = report.status
    else if (report) action.geometryCheck = 'reported'
  }
}

function planSummary(items) {
  return items.slice(0, MAX_PLAN_ITEMS).map(({ content, status }) => ({
    task: content.slice(0, MAX_LABEL_CHARS), status,
  }))
}

async function readBounded(path, limit) {
  const parent = dirname(path)
  if (await realpath(parent) !== parent) throw new Error('File directory changed')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Unexpected file type or size')
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error('File changed during read')
    return buffer.subarray(0, offset)
  } finally {
    await file.close()
  }
}

async function fileSignature(path) {
  try {
    const info = await lstat(path, { bigint: true })
    if (info.isFile()) return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return null
}

async function modelSignatures(cwd) {
  const models = new Map()
  for (const { path } of await discoverModels(cwd)) {
    if (!/\.usda?$/iu.test(path)) continue
    const absolute = join(cwd, path)
    const [signature, regions] = await Promise.all([fileSignature(absolute), fileSignature(regionPath(absolute))])
    if (signature) models.set(path, { signature, regions })
  }
  return models
}

function regionPath(modelPath) {
  return modelPath.replace(/\.usda?$/iu, '.regions.json')
}

async function regionStatus(cwd, path, hash) {
  if (!hash) return 'unverified'
  let raw
  try {
    raw = await readBounded(regionPath(join(cwd, path)), MAX_REGION_MAP_BYTES)
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'invalid'
  }
  try {
    const value = JSON.parse(raw.toString('utf8'))
    const map = readModelRegions(value, value?.sourceHash)
    if (value.sourceHash !== hash) return 'outdated'
    return needsSurfaceRegions(map) ? 'needs_surface_regions' : 'ready'
  } catch (_error) {
    return 'invalid'
  }
}

async function review(transport, key, state, signal, threshold) {
  const response = await transport(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Baseten returned HTTP ${response.status}`)
  }
  const { answers } = await response.json()
  return Object.fromEntries(Object.keys(questions).map(name => {
    const answer = answers?.[name]
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error('Baseten returned an invalid decision')
    }
    return [name, answer.noul >= threshold]
  }))
}

const needsMap = status => ['missing', 'invalid', 'outdated', 'needs_surface_regions'].includes(status)

async function changedModels(state, maxModels, signal) {
  const changes = []
  const digests = new Map()
  for (const [path, { signature, regions }] of await modelSignatures(state.cwd)) {
    signal.throwIfAborted()
    const before = state.baseline.get(path)
    if (before && signature === before.signature && regions === before.regions) continue
    const absolute = join(state.cwd, path)
    const cached = state.digests.get(path)
    let hash = cached?.signature === signature ? cached.hash : null
    if (!hash) {
      try {
        const bytes = await readBounded(absolute, USD_MAX_BYTES)
        if (await fileSignature(absolute) === signature) hash = createHash('sha256').update(bytes).digest('hex')
      } catch (_error) {
        // A model being replaced or unreadable has no verified region status.
      }
    }
    if (hash) digests.set(path, { signature, hash })
    const change = !before ? 'created' : signature === before.signature ? 'region_map_revised' : 'revised'
    changes.push({ path, signature, hash, change, status: await regionStatus(state.cwd, path, hash) })
    if (changes.length === maxModels) break
  }
  state.digests = digests
  return changes
}

function emptyProgress() {
  return { draft: '', textStep: 0 }
}

/**
 * Review completed steps in registered Print Studio conversations, one active review per project.
 * @param {object} ctx Host context.
 * @param {object} config Review cadence, limits and decision threshold.
 * @param {Function} resolveKey Resolve the Baseten credential at turn admission.
 * @param {Function} createUserMessage Create a durable steering message.
 * @param {typeof fetch} [transport=fetch] HTTP transport for the Bison decision API.
 */
export function applySkillReminders(ctx, config, resolveKey, createUserMessage, transport = fetch) {
  if (!config.enabled) return
  const turns = new WeakMap()
  const projects = new Map()
  const lifetime = new AbortController()

  async function evaluate(state, { textStep, draft }, request) {
    const { step, actions, plan } = state
    const signal = AbortSignal.any([state.signal, AbortSignal.timeout(config.timeoutMs)])
    try {
      const changes = await changedModels(state, config.maxModels, signal)
      signal.throwIfAborted()
      if (state.request !== request) return
      const flags = await review(transport, state.key, {
        request: request.text, draft, completedStep: step, recentActions: actions, plan,
        changedModels: changes.map(({ change, status }) => ({ change, regionMap: status })),
      }, signal, config.threshold)
      const unresolved = []
      if (flags.namedRegions && !state.sent.has('namedRegions')) {
        for (const { path, signature, hash, status } of changes) {
          signal.throwIfAborted()
          if (!needsMap(status) || await fileSignature(join(state.cwd, path)) !== signature) continue
          const current = await regionStatus(state.cwd, path, hash)
          if (current === status && await fileSignature(join(state.cwd, path)) === signature) {
            unresolved.push({ path, status: current })
          }
        }
      }
      const { agent } = state
      if (signal.aborted || state.request !== request || agent.inbox.nextStep.length || agent.status !== 'running') return
      const reminders = []
      if (unresolved.length) {
        state.sent.add('namedRegions')
        reminders.push(`Before ending this turn, follow name-model-regions and save maps that match the final revisions you keep. Use viewer_analyze_surfaces to identify physical features and audit each saved map for unnamed triangles. Finish any edits and validation first.\nCurrent region map findings\n${JSON.stringify(unresolved)}`)
      }
      if (flags.conciseReply && draft && textStep === state.textStep && !state.sent.has('conciseReply')) {
        state.sent.add('conciseReply')
        reminders.push('Reread the project reply guidance. Keep the reply short while preserving requested detail and safety information.')
      }
      if (reminders.length) {
        const guidance = "Print Studio skill reminder for the active request. Keep working toward the user's goal, including any remaining edits or checks. Apply this guidance as part of that work and report the outcome of the original request."
        agent.steer(createUserMessage({
          source: { kind: 'rumi-skill-reminder' },
          content: [{ type: 'text', text: [guidance, ...reminders].join('\n\n') }],
        }))
      }
    } catch (_error) {
      if (!state.signal.aborted) {
        ctx.logger.warn('Print Studio could not complete a Bison skill review. Work will continue.')
      }
    }
  }

  async function drainReviews(cwd, pending) {
    for (const state of pending) {
      pending.delete(state)
      state.scheduledStep = state.step
      const progress = state.progress
      state.progress = emptyProgress()
      if (!state.signal.aborted && state.sent.size < checkCount) {
        await evaluate(state, progress, state.request)
      }
      if (!pending.has(state)) {
        state.settled.resolve()
        state.settled = null
      }
    }
    projects.delete(cwd)
  }

  function schedule(state) {
    if (state.signal.aborted || state.step <= state.scheduledStep || state.sent.size === checkCount) return
    state.scheduledStep = state.step
    state.settled ??= Promise.withResolvers()
    const project = projects.get(state.cwd)
    if (project) {
      project.pending.add(state)
      return
    }
    const pending = new Set([state])
    projects.set(state.cwd, { pending, drain: Promise.resolve().then(() => drainReviews(state.cwd, pending)) })
  }

  function closeTurn(session) {
    const state = turns.get(session)
    if (!state) return
    turns.delete(session)
    projects.get(state.cwd)?.pending.delete(state)
    state.controller.abort()
    state.settled?.resolve()
  }

  ctx.effect(() => async () => {
    lifetime.abort()
    const drains = []
    for (const { pending, drain } of projects.values()) {
      for (const state of pending) state.settled.resolve()
      pending.clear()
      drains.push(drain)
    }
    await Promise.all(drains)
  }, 'print-studio: skill reminder lifetime')
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const request = messages.filter(message => message.source.kind === 'user').at(-1)
    const session = agent.session
    try {
      if (step === 1 && request && !signal.aborted) {
        const cwd = await realpath(session.header.cwd)
        const metadata = await readBounded(join(cwd, 'project.json'), 65_536).catch(error => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        const project = metadata && JSON.parse(metadata.toString('utf8'))
        if (project?.type === 'print' && project.id === basename(cwd) && Array.isArray(project.sessionIds) && project.sessionIds.includes(session.id)) {
          const key = await resolveKey()
          if (key && !signal.aborted && !lifetime.signal.aborted) {
            const baseline = await modelSignatures(cwd)
            const controller = new AbortController()
            const reviewSignal = AbortSignal.any([signal, controller.signal, lifetime.signal])
            if (!reviewSignal.aborted) turns.set(session, {
              agent, turn, key, cwd, baseline, controller, signal: reviewSignal,
              request: { text: text(request, config.maxTextChars) }, digests: new Map(), sent: new Set(),
              step: 0, scheduledStep: 0, textStep: 0, progress: emptyProgress(), stepProgress: emptyProgress(), settled: null,
              actions: [], stepActions: new Map(), plan: [],
            })
          }
        }
      } else {
        const state = turns.get(session)
        if (request && state?.turn === turn) {
          state.request = { text: text(request, config.maxTextChars) }
          state.progress = emptyProgress()
        }
      }
    } catch (_error) {
      ctx.logger.warn('Print Studio skill review could not capture the turn. The turn will continue.')
    }
    return next()
  })
  ctx.on('agent/disposed', ({ agent }) => closeTurn(agent.session))
  ctx.on('session/event', (session, { type, data }) => {
    const state = turns.get(session)
    if (!state) return
    if (type === 'todo/write') {
      state.plan = planSummary(data.todos)
      return
    }
    if (data.turn !== state.turn) return
    if (type === 'turn/end') {
      closeTurn(session)
      return
    }
    if (state.signal.aborted || state.sent.size === checkCount) return
    const progress = state.stepProgress
    if (type === 'assistant/message') {
      const draft = text(data.message, config.maxTextChars)
      if (draft) {
        progress.draft = draft
        progress.textStep = data.step
        state.textStep = data.step
      }
    } else if (type === 'tool/call') {
      state.stepActions.set(data.callId, describeToolCall(data))
      if (state.stepActions.size > MAX_ACTIONS) state.stepActions.delete(state.stepActions.keys().next().value)
    } else if (type === 'tool/result') {
      const action = state.stepActions.get(data.message.toolCallId)
      if (action) recordToolOutcome(action, data.message)
    } else if (type === 'step/end') {
      state.step = data.step
      state.actions = [...state.actions, ...state.stepActions.values()].slice(-MAX_ACTIONS)
      state.stepActions.clear()
      state.stepProgress = emptyProgress()
      const previous = state.progress
      state.progress = {
        draft: [previous.draft, progress.draft].filter(Boolean).join('\n').slice(-config.maxTextChars),
        textStep: progress.textStep || previous.textStep,
      }
      if (state.step % config.everySteps === 0) schedule(state)
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const state = turns.get(agent.session)
    if (state?.turn !== turn || state.signal.aborted) return
    schedule(state)
    if (!state.settled) return
    const timer = new AbortController()
    const signal = AbortSignal.any([state.signal, timer.signal])
    try {
      await Promise.race([state.settled.promise, sleep(config.timeoutMs, undefined, { signal })])
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      timer.abort()
    }
  })
}
