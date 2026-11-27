/** Evaluate completed project turns outside the agent loop and expose the owner's badge collection. */
import { owningProject, projectById } from '../print-project.js'
import { relative, resolve } from 'node:path'
import { createBadgeEvents } from './events.js'
import { openBadgeStore } from './store.js'
import { badgeCategory, badgeLabel, HABIT_BADGE_KINDS, PRINT_BADGE_KINDS } from './kinds.js'
import { latestSessionRoute } from './review-route.js'

function validationPath(event, project) {
  if (event.data.name !== 'validation_mechanics' || event.data.isError) return null
  let args = event.data.arguments
  if (event.type === 'tool/call') {
    try { args = JSON.parse(args) }
    catch (_invalidToolJson) { return null }
  }
  return typeof args?.path === 'string' ? relative(project.path, resolve(project.path, args.path)).split('\\').join('/') : null
}

function verifiedCompletedEnd(observation, endSeq) {
  const { events, inheritedEventCount } = observation
  const end = events[endSeq]
  if (!end || end.seq !== endSeq || end.type !== 'turn/end' || end.data.reason.kind !== 'completed' || endSeq < inheritedEventCount) {
    throw new Error('The saved badge review does not reference a completed project turn')
  }
  return { events, inheritedEventCount }
}

function turnEvents(observation, endSeq) {
  const { events, inheritedEventCount } = verifiedCompletedEnd(observation, endSeq)
  let first = endSeq
  while (first > inheritedEventCount && events[first - 1].type !== 'turn/end') first--
  return events.slice(first, endSeq + 1)
}

function projectEvents(observation, endSeq) {
  const { events, inheritedEventCount } = verifiedCompletedEnd(observation, endSeq)
  return events.slice(inheritedEventCount, endSeq + 1)
}

function eligibleMechanicalAwards(results, targets) {
  return results.map(({ kind, evidence, evidenceRefs, modelPath, revision, sourceHash, working }) => {
    if (!PRINT_BADGE_KINDS.includes(kind) || !targets.some(target => target.modelPath === modelPath && (target.changed || working === true)) || !evidence?.trim()
      || typeof working !== 'boolean' || !revision || !/^[\da-f]{64}$/u.test(sourceHash)
      || !Array.isArray(evidenceRefs) || !evidenceRefs.every(ref => typeof ref === 'string')) throw new Error('Invalid badge review result')
    return { kind, category: 'mechanical', evidence, evidenceRefs, modelPath, revision, sourceHash, working }
  })
}

function eligibleHabitAwards(results) {
  return results.map(({ kind, path, signals, evidence, evidenceRefs }) => {
    if (!HABIT_BADGE_KINDS.includes(kind)
      || !['practice', 'growth'].includes(path)
      || !Array.isArray(signals) || signals.length === 0 || !signals.every(code => typeof code === 'string')
      || !evidence?.trim()
      || !Array.isArray(evidenceRefs) || !evidenceRefs.every(ref => typeof ref === 'string')) throw new Error('Invalid badge review result')
    return { kind, category: 'habit', path, signals, evidence, evidenceRefs }
  })
}

/** Observe revision and turn changes at turn boundaries and run each project's review queue until disposal.
 * @param {object} ctx Scoped Print Studio host services.
 * @param {object} options Configured evaluators, revision inspector, and profile database path.
 * @returns {object} Owner-only gallery, live announcements, explicit retry, and quiescence operations.
 */
export function createBadgeHost(ctx, { databasePath, config, capture, review, reviewHabits = null }) {
  const store = openBadgeStore(databasePath)
  const reveals = createBadgeEvents()
  const lifetime = new AbortController()
  const turns = new WeakMap()
  const workspace = ctx.rumiProjectScope.workspaceRoot
  const tasks = new Map()

  async function evaluate(job) {
    const signal = lifetime.signal
    const metadata = projectById(workspace, job.projectId)
    if (!metadata?.sessionIds.includes(job.sessionId)) return []
    const observed = await ctx.sessionQuery.observeSession(job.sessionId, { projectionMode: 'none', signal })
    try {
      const session = { id: observed.header.id, header: observed.header }
      const project = owningProject(ctx.rumiProjectScope, session)
      if (!project || project.id !== job.projectId || session.id !== job.sessionId) return []
      const recordRequest = async record => {
        signal.throwIfAborted()
        if (!owningProject(ctx.rumiProjectScope, session)) throw new Error('The review project is no longer registered')
        store.recordRequest(job, record)
      }
      const sessionRoute = latestSessionRoute(observed.events.slice(0, job.turnEndSeq + 1))
      if (job.scope === 'habit') {
        if (!reviewHabits) return []
        const priorAwards = store.priorHabitAwards(job.projectId, job.sessionId)
        const events = projectEvents(observed, job.turnEndSeq)
        const results = await reviewHabits(ctx, {
          session, project, events, turnEndSeq: job.turnEndSeq, unearnedKinds: HABIT_BADGE_KINDS, priorAwards, sessionRoute, signal, recordRequest,
        }, config)
        signal.throwIfAborted()
        if (!owningProject(ctx.rumiProjectScope, session)) return []
        return eligibleHabitAwards(results)
      }
      const events = turnEvents(observed, job.turnEndSeq)
      const results = await review(ctx, {
        session, project, events, turnEndSeq: job.turnEndSeq, targets: job.targets, sessionRoute, signal, recordRequest,
      }, config)
      signal.throwIfAborted()
      if (!owningProject(ctx.rumiProjectScope, session)) return []
      return eligibleMechanicalAwards(results, job.targets)
    } finally { observed[Symbol.dispose]() }
  }

  async function drain(projectId) {
    try {
      while (!lifetime.signal.aborted) {
        const job = store.take(projectId)
        if (!job) break
        let inserted
        try {
          const awards = await evaluate(job)
          lifetime.signal.throwIfAborted()
          inserted = store.commit(job, awards)
        } catch (error) {
          if (lifetime.signal.aborted) return
          store.fail(job)
          ctx.logger.warn(`Print Studio badge review failed for ${job.sessionId}/${job.turnEndSeq}: ${error.code ?? error.name}`)
          continue
        }
        if (inserted.length > 0) {
          try {
            const project = projectById(workspace, projectId)
            if (!project?.sessionIds.includes(job.sessionId)) continue
            const announcement = { projectId, projectName: project.name, awards: inserted }
            reveals.publish(announcement)
            const enrichedAwards = inserted.map(award => ({
              ...award,
              label: badgeLabel(award.kind),
              category: award.category ?? badgeCategory(award.kind),
            }))
            await ctx.parallel('rumi/print-badge-earned', { ...announcement, awards: enrichedAwards, projectPath: project.path })
          } catch (error) {
            ctx.logger.warn(`Print Studio saved the badges for ${job.sessionId}/${job.turnEndSeq} but could not present them: ${error.code ?? error.name}`)
          }
        }
      }
    } catch (error) {
      ctx.logger.warn(`Print Studio badge storage could not finish a review: ${error.code ?? error.name}`)
    } finally {
      tasks.delete(projectId)
    }
  }

  function schedule(projectId) {
    if (config.enabled === false || lifetime.signal.aborted || tasks.has(projectId)) return
    const completion = Promise.resolve().then(() => drain(projectId))
    tasks.set(projectId, completion)
  }

  function observe(session, event) {
    if (event.type === 'turn/start') {
      const project = owningProject(ctx.rumiProjectScope, session)
      if (project) turns.set(session, {
        project, turn: event.data.turn, hadUserMessage: false,
        baseline: new Map(capture(project.path).map(item => [item.modelPath, item.statKey])), checked: new Set(),
      })
      return
    }
    const state = turns.get(session)
    if (!state) return
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      state.hadUserMessage = true
      return
    }
    if (event.type !== 'tool/ptc-dispatch' && event.data.turn !== state.turn) return
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') {
      const path = validationPath(event, state.project)
      if (path) state.checked.add(path)
    }
    if (event.type !== 'turn/end') return
    turns.delete(session)
    if (event.data.reason.kind !== 'completed' || !owningProject(ctx.rumiProjectScope, session)) return
    const targets = []
    for (const item of capture(state.project.path)) {
      const changed = state.baseline.get(item.modelPath) !== item.statKey
      if (changed || state.checked.has(item.modelPath)) targets.push({ ...item, changed })
    }
    let queued = false
    if (targets.length) {
      store.enqueue(state.project.id, session.id, event.seq, targets, 'mechanical')
      queued = true
    }
    if (reviewHabits && (state.hadUserMessage || targets.length > 0)) {
      store.enqueue(state.project.id, session.id, event.seq, { kinds: HABIT_BADGE_KINDS }, 'habit')
      queued = true
    }
    if (queued) schedule(state.project.id)
  }

  function collection(projectId) {
    const projects = new Map()
    const project = id => {
      if (projectId !== null && id !== projectId) return null
      if (!projects.has(id)) projects.set(id, projectById(workspace, id))
      return projects.get(id)
    }
    const awards = []
    for (const award of store.awards()) {
      const owner = project(award.projectId)
      if (owner?.sessionIds.includes(award.sessionId)) awards.push({ ...award, projectName: owner.name })
    }
    const counts = { pending: 0, failed: 0 }
    for (const { projectId: id, sessionId, status, count } of store.pendingByProject()) {
      if (project(id)?.sessionIds.includes(sessionId)) counts[status === 'failed' ? 'failed' : 'pending'] += count
    }
    return { awards, ...counts }
  }

  ctx.on('session/event', (session, event) => {
    if (config.enabled === false || lifetime.signal.aborted) return
    try { observe(session, event) }
    catch (error) { ctx.logger.warn(`Print Studio could not track a badge revision: ${error.code ?? error.name}`) }
  })
  ctx.effect(() => async () => {
    lifetime.abort()
    reveals.close()
    await Promise.all(tasks.values())
    store.close()
  }, 'print-studio: badge reviews')
  for (const { projectId, status } of store.pendingByProject()) {
    if (status === 'pending') schedule(projectId)
  }
  return {
    collection,
    subscribe: (request) => reveals.response(request.signal),
    knownProject: id => projectById(workspace, id) !== null,
    retry(projectId) {
      let queued = 0
      for (const entry of store.pendingByProject()) {
        if (entry.status !== 'failed' || (projectId !== null && entry.projectId !== projectId)) continue
        if (config.enabled === false || !projectById(workspace, entry.projectId)?.sessionIds.includes(entry.sessionId)) continue
        const updated = store.retry(entry.projectId, entry.sessionId)
        if (updated) schedule(entry.projectId)
        queued += updated
      }
      return { queued }
    },
    async whenIdle(projectId) {
      if (projectId === undefined) await Promise.all(tasks.values())
      else await tasks.get(projectId)
    },
  }
}
