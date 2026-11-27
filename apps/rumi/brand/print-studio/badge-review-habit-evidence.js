/** Deterministically extract project-level Language, Patience, and Persistence signals from session logs and disk state. */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const VOICE_GRACE_MS = 6_000
const SUBSTANTIVE_DURATION_MS = 10_000
const HEAVY_DURATION_MS = 15_000
const MAX_TURNS_SUMMARY = 32
const MAX_MESSAGES = 24
const MAX_MESSAGE_CHARS = 360
const MAX_ASSISTANT_CHARS = 220
const MAX_RESULT_CHARS = 128 * 1024
const MAX_MODELS = 64
const MAX_REVISIONS = 128
const REVISION_PATTERN = /^[a-f\d]{32}$/u
const LAYOUT_PATTERN = /^\.rumi-print-layout-([a-f\d]{64})\.json$/u
const PRIVATE_LINE = /\b(password|credentials?|email|authorization|secret|api[_ -]?key|bearer|cookie|token|environ)\b/iu
const QUANTITATIVE_OR_SPATIAL_CUE = /\b(\d+(?:\.\d+)?\s*(?:mm|cm|in|inch|inches|deg|degrees|%|x|times)?|millimet(?:er|re)s?|centimet(?:er|re)s?|half|twice|double|wider|narrower|taller|shorter|thicker|thinner|deeper|hollow|rounded|chamfer|bevel|tapered|flush|centered|aligned|attached|snap|slot|groove|hinge|axle|gear|lip|lid|base|handle|wall|edge|corner|inside|outside|left|right|front|back|top|bottom)\b/iu
const WRAP_UP_CUE = /\b(perfect|awesome|looks?\s+(?:great|good|right|awesome|done|ready)|ready\s+to\s+print|let'?s\s+(?:keep|print|use)\s+(?:this|that|it)|that\s+(?:fixed|works|solved)|fixed\s+it|all\s+done|we'?re\s+done|i'?m\s+done|love\s+it|keep\s+this)\b/iu
const NON_ZERO_BASH = /(?:^|\n)\[(?:exit code: 0*[1-9]|killed by signal:|timed out after |still running after |stopped: )/u

function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)
}

function eventTimeMs(event) {
  if (typeof event?.time === 'number' && Number.isFinite(event.time)) return event.time
  if (typeof event?.time === 'string') {
    const parsed = Date.parse(event.time)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractText(message, limit) {
  const parts = []
  let remaining = limit
  for (const block of message?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const excerpt = block.text.slice(0, remaining)
    parts.push(excerpt)
    remaining -= excerpt.length
    if (remaining <= 0) break
  }
  return parts.join('\n')
}

function sanitizeExcerpt(raw, limit) {
  const clean = raw.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !PRIVATE_LINE.test(line))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return clean.slice(0, limit)
}

function parseJsonBounded(text) {
  if (typeof text !== 'string' || text.length > MAX_RESULT_CHARS) return undefined
  try { return JSON.parse(text) }
  catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function scanDiskArtifacts(projectPath) {
  const revisions = new Set()
  const layouts = []
  let printHandoff = null
  if (typeof projectPath !== 'string' || !projectPath) return { revisions: 0, layouts, printHandoff }
  let canonicalRoot
  try { canonicalRoot = realpathSync(projectPath) }
  catch (error) {
    if (missing(error)) return { revisions: 0, layouts, printHandoff }
    throw error
  }
  try {
    for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = LAYOUT_PATTERN.exec(entry.name)
      if (match) {
        const info = lstatSync(join(canonicalRoot, entry.name))
        if (info.isFile() && info.nlink === 1) layouts.push(`layout:${match[1].slice(0, 12)}`)
      } else if (entry.name === '.rumi-print-handoff.json') {
        const file = join(canonicalRoot, entry.name)
        const info = lstatSync(file)
        if (info.isFile() && info.nlink === 1 && info.size <= 16_384) {
          const parsed = parseJsonBounded(readFileSync(file, 'utf8'))
          if (typeof parsed?.openedAt === 'string' && typeof parsed?.model === 'string') {
            printHandoff = { ref: 'handoff:print', model: parsed.model.slice(0, 128), openedAt: parsed.openedAt }
          }
        }
      }
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  const modelsDir = join(canonicalRoot, 'models')
  try {
    if (realpathSync(modelsDir) === modelsDir) {
      for (const model of readdirSync(modelsDir, { withFileTypes: true }).slice(0, MAX_MODELS)) {
        if (!model.isDirectory() || model.name.startsWith('.')) continue
        const revDir = join(modelsDir, model.name, 'revisions')
        try {
          if (realpathSync(revDir) !== revDir) continue
          for (const rev of readdirSync(revDir, { withFileTypes: true }).slice(0, MAX_REVISIONS)) {
            if (rev.isDirectory() && REVISION_PATTERN.test(rev.name)) {
              revisions.add(`${model.name}/${rev.name}`)
            }
          }
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
    }
  } catch (error) {
    if (!missing(error)) throw error
  }
  return { revisions: revisions.size, layouts: layouts.slice(0, 8), printHandoff }
}

function hasBlockingChecks(output) {
  for (const match of output.matchAll(/(?:^|\n)RUMI_CHECKS (\{[^\r\n]{1,16384}\})(?=\r?\n|$)/gu)) {
    const checks = parseJsonBounded(match[1])
    if (!checks) continue
    if (checks.ok === false || checks.blocking === true) return true
    if (Array.isArray(checks.blocking) && checks.blocking.length > 0) return true
    if (Array.isArray(checks.errors) && checks.errors.length > 0) return true
    if (Array.isArray(checks.findings) && checks.findings.some(item => item?.severity === 'error' || item?.blocking === true)) return true
  }
  return false
}

function modelRevisionsFromOutput(output) {
  const found = []
  for (const match of output.matchAll(/(?:^|\n)RUMI_MODEL (\{[^\r\n]{1,8192}\})(?=\r?\n|$)/gu)) {
    const receipt = parseJsonBounded(match[1])
    if (typeof receipt?.revisionUsd !== 'string') continue
    const rev = dirname(receipt.revisionUsd).split('/').at(-1)
    if (rev && REVISION_PATTERN.test(rev)) found.push(rev)
  }
  return found
}

/**
 * Extract structured, citation-backed facts and deterministic eligibility gates for habit badges.
 * @param {string} projectPath Canonical registered project directory.
 * @param {object[]} events Contiguous session events from `inheritedEventCount` through `turnEndSeq`.
 * @param {readonly string[]} unearnedKinds Habit badge kinds not yet earned in this project.
 * @returns {object} Eligibility flags, bounded evaluator input, and valid citation references.
 */
export function extractHabitBadgeEvidence(projectPath, events, unearnedKinds) {
  const voiceRefUserIds = new Set()
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.source?.kind === 'rumi-voice-reference'
      && typeof event.data.source.userMessageId === 'string') {
      voiceRefUserIds.add(event.data.source.userMessageId)
    }
  }

  const turns = []
  const sessionRevisions = new Set()
  let current = null

  function finishTurn(endEvent) {
    if (!current) return
    const endTime = eventTimeMs(endEvent)
    const durationMs = current.startTime !== null && endTime !== null ? Math.max(0, endTime - current.startTime) : null
    const reason = endEvent?.data?.reason
    const endKind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
    const userAborted = (endKind === 'aborted' && reason?.reason?.kind === 'user') || current.assistantInterrupted
    const clean = endKind === 'completed' && !userAborted && current.midTurnSteers === 0
    const substantive = current.toolCallCount > 0 || (durationMs !== null && durationMs >= SUBSTANTIVE_DURATION_MS)
      || current.publishedRevisions.length > 0
    const heavyWork = current.toolCallCount >= 2 || current.stepCount >= 2
      || (durationMs !== null && durationMs >= HEAVY_DURATION_MS)
      || current.toolNames.has('validation_mechanics')
    const endedWithSetback = current.unresolvedErrorRef !== null || current.unresolvedCheckRef !== null
    turns.push({
      ref: `turn:${current.index}`,
      index: current.index,
      endSeq: endEvent?.seq ?? current.startSeq,
      endReason: userAborted ? 'aborted-by-user' : endKind,
      durationMs,
      stepCount: current.stepCount,
      toolCallCount: current.toolCallCount,
      toolNames: [...current.toolNames],
      humanMessages: current.humanMessages,
      assistantSummary: current.assistantSummary,
      assistantAskedQuestion: current.assistantSummary.includes('?'),
      userAborted,
      midTurnSteers: current.midTurnSteers,
      clean,
      substantive,
      heavyWork,
      publishedRevisions: current.publishedRevisions,
      setbackRef: endedWithSetback ? (current.unresolvedCheckRef ?? current.unresolvedErrorRef) : null,
      mechanicsPassed: current.mechanicsPassed,
      validationAccepted: current.validationAccepted,
      milestoneRef: current.milestoneRef,
    })
    current = null
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      current = {
        index: turns.length + 1,
        startSeq: event.seq,
        startTime: eventTimeMs(event),
        stepCount: 0,
        sawStepStart: false,
        sawToolResult: false,
        toolCallCount: 0,
        toolNames: new Set(),
        calls: new Map(),
        humanMessages: [],
        assistantSummary: '',
        assistantInterrupted: false,
        midTurnSteers: 0,
        publishedRevisions: [],
        unresolvedErrorRef: null,
        unresolvedCheckRef: null,
        mechanicsPassed: false,
        validationAccepted: false,
        milestoneRef: null,
      }
      continue
    }
    if (!current) continue

    if (event.type === 'step/start') {
      current.stepCount += 1
      current.sawStepStart = true
      continue
    }

    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = sanitizeExcerpt(extractText(event.data, 2000), MAX_MESSAGE_CHARS)
      const msgTime = eventTimeMs(event)
      const offsetMs = current.startTime !== null && msgTime !== null ? Math.max(0, msgTime - current.startTime) : null
      if (current.sawStepStart) {
        const withinVoiceGrace = !current.sawToolResult && offsetMs !== null && offsetMs <= VOICE_GRACE_MS
        if (!withinVoiceGrace) current.midTurnSteers += 1
      }
      if (text) {
        current.humanMessages.push({
          ref: `msg:${event.seq}`,
          seq: event.seq,
          turnRef: `turn:${current.index}`,
          text,
          wordCount: text.split(/\s+/u).filter(Boolean).length,
          hasVoiceReference: typeof event.data.id === 'string' && voiceRefUserIds.has(event.data.id),
          hasCue: QUANTITATIVE_OR_SPATIAL_CUE.test(text),
          hasWrapUp: WRAP_UP_CUE.test(text),
        })
      }
      continue
    }

    if (event.type === 'assistant/message') {
      if (event.data?.interrupted === true) current.assistantInterrupted = true
      const text = sanitizeExcerpt(extractText(event.data?.message, 1000), MAX_ASSISTANT_CHARS)
      if (text) current.assistantSummary = text
      continue
    }

    if (event.type === 'tool/call') {
      current.toolCallCount += 1
      if (typeof event.data?.name === 'string') {
        current.toolNames.add(event.data.name)
        current.calls.set(event.data.callId, event.data.name)
      }
      continue
    }

    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      current.sawToolResult = true
      const isPtc = event.type === 'tool/ptc-dispatch'
      const message = isPtc ? event.data : event.data?.message
      const toolName = isPtc ? event.data?.name : current.calls.get(message?.toolCallId)
      if (isPtc && typeof toolName === 'string') {
        current.toolCallCount += 1
        current.toolNames.add(toolName)
      }
      const output = extractText(message, MAX_RESULT_CHARS)
      const failed = Boolean(message?.isError) || (toolName === 'bash' && NON_ZERO_BASH.test(output))
      if (failed) {
        current.unresolvedErrorRef = `check:${event.seq}`
      } else if (toolName === 'bash') {
        const revs = modelRevisionsFromOutput(output)
        for (const rev of revs) {
          sessionRevisions.add(rev)
          if (!current.publishedRevisions.includes(rev)) current.publishedRevisions.push(rev)
        }
        if (hasBlockingChecks(output)) {
          current.unresolvedCheckRef = `check:${event.seq}`
        } else if (revs.length > 0) {
          // A clean publish later in the same turn resolves earlier intra-turn syntax/check errors.
          current.unresolvedErrorRef = null
          current.unresolvedCheckRef = null
        }
      } else if (toolName === 'validation_mechanics') {
        const parsed = parseJsonBounded(output)
        if (parsed?.status === 'passed' && parsed?.report?.assemblyVerified === true) {
          current.mechanicsPassed = true
          current.unresolvedErrorRef = null
          current.unresolvedCheckRef = null
          current.milestoneRef = `check:${event.seq}`
        } else if (parsed && parsed.status !== 'passed') {
          current.unresolvedCheckRef = `check:${event.seq}`
        }
      } else if (toolName === 'validation_accept') {
        const parsed = parseJsonBounded(output)
        if (parsed?.accepted === true || parsed?.status === 'accepted' || !message?.isError) {
          current.validationAccepted = true
          current.unresolvedErrorRef = null
          current.unresolvedCheckRef = null
          current.milestoneRef = `check:${event.seq}`
        }
      }
      continue
    }

    if (event.type === 'turn/end') {
      finishTurn(event)
    }
  }

  const disk = scanDiskArtifacts(projectPath)
  const humanTurns = turns.filter(turn => turn.humanMessages.length > 0)
  const latestTurn = turns.at(-1) ?? null
  const latestHuman = humanTurns.at(-1)?.humanMessages.at(-1) ?? null

  // --- Patience deterministic metrics ---
  const substantiveTurns = turns.filter(turn => turn.substantive)
  let cleanStreakTurns = []
  for (let index = substantiveTurns.length - 1; index >= 0; index -= 1) {
    const turn = substantiveTurns[index]
    if (turn.clean) cleanStreakTurns.unshift(turn)
    else break
  }
  const streakStart = cleanStreakTurns[0]?.index ?? Infinity
  const earlierInterruptions = turns.filter(turn => turn.index < streakStart && (turn.userAborted || turn.midTurnSteers > 0))
  const hadHeavyWaitInStreak = cleanStreakTurns.some(turn => turn.heavyWork)
  const patiencePracticeEligible = cleanStreakTurns.length >= 3 && hadHeavyWaitInStreak
  const patienceGrowthEligible = earlierInterruptions.length > 0 && cleanStreakTurns.length >= 2 && hadHeavyWaitInStreak
  const patienceEligible = Boolean(latestTurn?.clean) && (patiencePracticeEligible || patienceGrowthEligible)

  // --- Persistence deterministic metrics ---
  const totalRevisions = Math.max(sessionRevisions.size, disk.revisions)
  const crossTurnSetbacks = []
  for (let index = 0; index < turns.length - 1; index += 1) {
    if (!turns[index].setbackRef) continue
    const laterHumanTurns = turns.slice(index + 1).filter(turn => turn.humanMessages.length > 0)
    if (laterHumanTurns.length > 0) {
      crossTurnSetbacks.push({
        turnRef: turns[index].ref,
        ref: turns[index].setbackRef,
        subsequentHumanTurns: laterHumanTurns.length,
        subsequentRevisions: new Set(turns.slice(index + 1).flatMap(turn => turn.publishedRevisions)).size,
      })
    }
  }
  const stoppingPoints = []
  for (const turn of turns) {
    if (turn.validationAccepted && turn.milestoneRef) stoppingPoints.push({ kind: 'validation-accepted', ref: turn.milestoneRef, turnRef: turn.ref })
    else if (turn.mechanicsPassed && turn.milestoneRef) stoppingPoints.push({ kind: 'mechanics-passed', ref: turn.milestoneRef, turnRef: turn.ref })
  }
  for (const ref of disk.layouts) stoppingPoints.push({ kind: 'print-layout-saved', ref })
  if (disk.printHandoff) stoppingPoints.push({ kind: 'print-handoff', ref: disk.printHandoff.ref })
  const latestUnresolved = Boolean(latestTurn?.setbackRef) || latestTurn?.endReason !== 'completed'
  const hasPostSetbackIteration = crossTurnSetbacks.some(setback => setback.subsequentHumanTurns >= 2)
  const persistenceEligible = !latestUnresolved
    && humanTurns.length >= 3
    && totalRevisions >= 2
    && (hasPostSetbackIteration || stoppingPoints.length > 0 || totalRevisions >= 3 || Boolean(latestHuman?.hasWrapUp))

  // --- Language deterministic metrics ---
  const allMessages = humanTurns.flatMap(turn => turn.humanMessages)
  const languageCadenceHit = humanTurns.length === 2
    || (humanTurns.length >= 3 && (humanTurns.length % 2 === 0 || Boolean(latestHuman?.hasCue) || patienceEligible || persistenceEligible))
  const languageEligible = humanTurns.length >= 2 && allMessages.length >= 2 && languageCadenceHit

  const eligibleKinds = unearnedKinds.filter(kind => (
    (kind === 'language' && languageEligible)
    || (kind === 'patience' && patienceEligible)
    || (kind === 'persistence' && persistenceEligible)
  ))

  // Build bounded messages & turns payload and exact valid ref catalog.
  const sampledMessages = allMessages.length <= MAX_MESSAGES
    ? allMessages
    : [...allMessages.slice(0, 8), ...allMessages.slice(-(MAX_MESSAGES - 8))]
  const sampledTurns = turns.slice(-MAX_TURNS_SUMMARY)
  const prevAssistantByTurn = new Map()
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index - 1].assistantSummary) {
      prevAssistantByTurn.set(turns[index].ref, turns[index - 1].assistantSummary)
    }
  }

  const validRefs = new Set()
  const validMessageRefs = new Set()
  const streakTurnRefs = new Set(cleanStreakTurns.map(turn => turn.ref))
  for (const turn of sampledTurns) {
    validRefs.add(turn.ref)
    if (turn.setbackRef) validRefs.add(turn.setbackRef)
    if (turn.milestoneRef) validRefs.add(turn.milestoneRef)
    for (const rev of turn.publishedRevisions) validRefs.add(`rev:${rev.slice(0, 12)}`)
  }
  for (const msg of sampledMessages) {
    validRefs.add(msg.ref)
    validMessageRefs.add(msg.ref)
  }
  for (const setback of crossTurnSetbacks) {
    validRefs.add(setback.ref)
    validRefs.add(setback.turnRef)
  }
  for (const point of stoppingPoints) validRefs.add(point.ref)

  const facts = {
    candidateKinds: eligibleKinds,
    projectSummary: {
      totalTurns: turns.length,
      humanTurnCount: humanTurns.length,
      distinctRevisions: totalRevisions,
      latestTurnClean: !latestUnresolved,
    },
    messages: sampledMessages.map(msg => ({
      ref: msg.ref,
      turn: msg.turnRef,
      text: msg.text,
      ...(msg.hasVoiceReference ? { pointedAtModel: true } : {}),
      ...(prevAssistantByTurn.has(msg.turnRef) ? { previousAssistantReply: prevAssistantByTurn.get(msg.turnRef) } : {}),
    })),
    turns: sampledTurns.map(turn => ({
      ref: turn.ref,
      endReason: turn.endReason,
      ...(turn.durationMs !== null ? { durationSeconds: Math.round(turn.durationMs / 1000) } : {}),
      steps: turn.stepCount,
      toolCalls: turn.toolCallCount,
      clean: turn.clean,
      heavyWork: turn.heavyWork,
      ...(turn.midTurnSteers > 0 ? { midTurnSteers: turn.midTurnSteers } : {}),
      ...(turn.userAborted ? { userAborted: true } : {}),
      ...(turn.publishedRevisions.length ? { revisions: turn.publishedRevisions.map(rev => `rev:${rev.slice(0, 12)}`) } : {}),
      ...(turn.setbackRef ? { setbackRef: turn.setbackRef } : {}),
      ...(turn.milestoneRef ? { milestoneRef: turn.milestoneRef } : {}),
      ...(turn.humanMessages.length ? { userRefs: turn.humanMessages.map(msg => msg.ref) } : {}),
      ...(turn.assistantSummary ? { assistantSummary: turn.assistantSummary } : {}),
    })),
    patience: {
      eligible: patienceEligible,
      practiceEligible: patiencePracticeEligible,
      growthEligible: patienceGrowthEligible,
      cleanSubstantiveStreak: cleanStreakTurns.length,
      streakTurnRefs: cleanStreakTurns.map(turn => turn.ref),
      earlierInterruptionTurnRefs: earlierInterruptions.map(turn => turn.ref),
    },
    persistence: {
      eligible: persistenceEligible,
      distinctRevisions: totalRevisions,
      crossTurnSetbacks,
      stoppingPoints,
    },
  }

  return {
    eligibleKinds,
    facts,
    validRefs,
    validMessageRefs,
    streakTurnRefs,
    patience: facts.patience,
    persistence: facts.persistence,
    humanTurnCount: humanTurns.length,
    latestUnresolved,
  }
}
