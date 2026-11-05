/** Request-time model references and agent-declared work, independent of viewer selection. */
export const MODEL_FOCUS_GUIDANCE = 'Resolve model references before editing. Explicit model names and captured pointing references take precedence over the selected model. For an otherwise unqualified request, use the selection captured when that request entered the inbox, not a later selection. Voice references include the selection at speech capture; prefer that over inbox-time selection. Continued work stays on its established model. If a new selection conflicts with ongoing work and intent is ambiguous, ask which model the person means. Browsing alone never retargets work. Call viewer_working_model with the discovered model entry before inspecting or editing that model; change it when your work changes targets. Clear it before asking a clarification or when no model is being worked on. The green dot reports your declared work, not a lock, proof of an edit, or the user selection. If the model does not exist yet, create its entry first. Use viewer_load only when you intend to change what the person sees.'

/**
 * Bind transient focus to each agent and capture selection when human input enters its inbox.
 * @param {object} ctx Host plugin context.
 * @param {{read: Function, notify: Function}} options Viewer lookup and invalidation.
 * @returns {object} Work declaration and session-level work paths.
 */
export function createModelFocus(ctx, { read, notify }) {
  const agents = new Map()
  function state(agent) {
    let value = agents.get(agent)
    if (!value) { value = { pending: new Map(), requests: [], turn: null, working: null }; agents.set(agent, value) }
    return value
  }
  function selection(sessionId) {
    const record = read(sessionId), design = record?.source?.state()
    return record?.selectedModel ? { path: record.selectedModel, revision: design?.revision ?? null } : null
  }
  function clear(agent, dispose = false) {
    const value = agents.get(agent)
    if (!value) return
    const changed = value.working !== null
    value.working = null; value.requests = []; value.turn = null
    if (dispose || value.pending.size === 0) agents.delete(agent)
    if (changed) notify(agent.session.id)
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind === 'user') state(agent).pending.set(message.id, selection(agent.session.id))
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind !== 'user') return
    const value = state(agent)
    if (value.turn !== turn) { value.requests = []; value.turn = turn }
    value.requests.push({ messageId: message.id, selectionAtAdmission: value.pending.get(message.id) ?? null })
    value.pending.delete(message.id)
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => { agents.get(agent)?.pending.delete(message.id) })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') clear(agent) })
  ctx.on('agent/disposed', ({ agent }) => clear(agent, true))
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'rumi:model-reference-policy', order: scoped.systemPrompt.getSectionOrder('TOOL_WORKFLOW'), text: MODEL_FOCUS_GUIDANCE,
    }), 'print viewer: model reference policy')
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'rumi:model-focus', order: scoped.systemPrompt.getContextOrder('WEB_SURFACE'), interpolate: false, required: true,
      text: ({ agent }) => {
        if (!agent) return ''
        const record = read(agent.session.id), value = agents.get(agent)
        return JSON.stringify({ modelFocus: {
          currentSelection: selection(agent.session.id),
          requests: value?.requests ?? [],
          workingModel: value?.working ?? null,
          availableModels: record?.models ?? [],
        } })
      },
    }), 'print viewer: model reference context')
  })
  ctx.effect(() => () => { agents.clear() }, 'print viewer: model focus lifetime')
  return {
    /** Declare validated work without moving the user selection. */
    set(agent, path) {
      if (agent.status !== 'running') throw new Error('Model work requires a running agent')
      state(agent).working = path
      notify(agent.session.id)
    },
    /** Reject selected-model operations when browsing has moved away from declared work. */
    assertSelected(agent, selected) {
      const target = agents.get(agent)?.working
      if (target && target !== selected) throw new Error(`Work is declared on ${target}, but the viewer selection differs. Read mesh_state and resolve the target before acting.`)
    },
    /** Active declared paths for one conversation, including concurrent agents. */
    paths(sessionId) {
      return [...new Set([...agents].filter(([agent, value]) => agent.session.id === sessionId && value.working !== null)
        .map(([, value]) => value.working))]
    },
  }
}
