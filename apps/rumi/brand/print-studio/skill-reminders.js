/** Run one bounded Bison review before a Print Studio turn closes. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { discoverModels } from './viewer/catalog.js'
import { readModelRegions } from './viewer/model-regions.js'
import { USD_MAX_BYTES } from './viewer/usd.js'

const endpoint = 'https://inference.baseten.co/v1/systemone'
const model = 'decision-models/baseten-bison-latest'
const questions = {
  namedRegions: {
    type: 'noul',
    instructions: 'Did this turn create or revise an editable USD model whose region map is missing, invalid, or outdated? Use the supplied changed model status as evidence. A ready or unverified map alone does not warrant a reminder.',
  },
  conciseReply: {
    type: 'noul',
    instructions: 'Would the draft materially benefit from rereading Rumi reply guidance? For a child asking to make, check, or fix something, aim for under 35 words and at most two short sentences. Preserve requested detail and safety information. Judge the draft against the request.',
  },
}

const text = (message, limit) => (message?.content ?? [])
  .filter(block => block.type === 'text')
  .map(block => block.text.slice(0, limit))
  .join('\n').slice(0, limit)

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

async function modelSignatures(cwd) {
  const models = (await discoverModels(cwd)).filter(entry => /\.usda?$/iu.test(entry.path))
  return new Map(await Promise.all(models.map(async ({ path }) => {
    const info = await lstat(join(cwd, path), { bigint: true })
    return [path, `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`]
  })))
}

async function regionStatus(cwd, path) {
  let hash
  try {
    hash = createHash('sha256').update(await readBounded(join(cwd, path), USD_MAX_BYTES)).digest('hex')
  } catch (_error) {
    return { path, status: 'unverified' }
  }
  let raw
  try {
    raw = await readBounded(join(cwd, path.replace(/\.usda?$/iu, '.regions.json')), 65_536)
  } catch (error) {
    return { path, status: error.code === 'ENOENT' ? 'missing' : 'invalid' }
  }
  try {
    const value = JSON.parse(raw.toString('utf8'))
    readModelRegions(value, value?.sourceHash)
    return { path, status: value.sourceHash === hash ? 'ready' : 'outdated' }
  } catch (_error) {
    return { path, status: 'invalid' }
  }
}

async function review(key, state, signal, threshold) {
  const response = await fetch(endpoint, {
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

/**
 * Review only registered Print Studio conversations with user input and a closing draft.
 * @param {object} ctx Host context.
 * @param {object} config Review limits and decision threshold.
 * @param {Function} resolveKey Resolve the Baseten credential at turn admission.
 * @param {Function} createUserMessage Create a durable steering message.
 */
export function applySkillReminders(ctx, config, resolveKey, createUserMessage) {
  if (!config.enabled) return
  const turns = new WeakMap()
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'print-studio: skill reminder lifetime')
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
            turns.set(session, { turn, key, cwd, baseline: await modelSignatures(cwd), request: text(request, config.maxTextChars) })
          }
        }
      } else if (request && turns.get(session)?.turn === turn) {
        turns.get(session).request = text(request, config.maxTextChars)
      }
    } catch (_error) {
      ctx.logger.warn('Print Studio skill review could not capture the turn. The turn will continue.')
    }
    return next()
  })
  ctx.on('session/event', (session, event) => {
    const state = turns.get(session)
    if (!state || event.data.turn !== state.turn) return
    if (event.type === 'assistant/message') state.draft = text(event.data.message, config.maxTextChars)
    if (event.type === 'turn/end') turns.delete(session)
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const session = agent.session
    const state = turns.get(session)
    if (state?.turn !== turn || !state.draft) return
    turns.delete(session)
    const reviewSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(config.timeoutMs)])
    try {
      const { cwd } = state
      const changes = []
      for (const [path, signature] of await modelSignatures(cwd)) {
        reviewSignal.throwIfAborted()
        if (signature === state.baseline.get(path)) continue
        changes.push(await regionStatus(cwd, path))
        if (changes.length === config.maxModels) break
      }
      const flags = await review(state.key, {
        request: state.request, draft: state.draft, changedModels: changes.map(({ status }) => ({ regionMap: status })),
      }, reviewSignal, config.threshold)
      const reminders = []
      const unresolved = changes.filter(({ status }) => ['missing', 'invalid', 'outdated'].includes(status))
      if (flags.namedRegions && unresolved.length) {
        reminders.push(`Reread name-model-regions and complete the region maps for these saved revisions: ${JSON.stringify(unresolved)}.`)
      }
      if (flags.conciseReply) reminders.push('Reread the project reply guidance. Shorten the final reply while preserving requested detail and safety information.')
      if (reminders.length && !reviewSignal.aborted && agent.inbox.nextStep.length === 0) {
        agent.steer(createUserMessage({
          source: { kind: 'rumi-skill-reminder' },
          content: [{ type: 'text', text: `Print Studio completion review:\n${reminders.join('\n')}` }],
        }))
      }
    } catch (_error) {
      if (!signal.aborted && !lifetime.signal.aborted) {
        ctx.logger.warn('Print Studio could not complete the Bison skill review. The draft will finish without a reminder.')
      }
    }
  })
}
