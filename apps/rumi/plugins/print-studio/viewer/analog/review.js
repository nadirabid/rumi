/** Source-owned prepare, evidence, assessment, and presentation lifecycle. */
import { randomUUID } from 'node:crypto'
import { normalizeShape } from './spec.js'
import { controlReviewCases } from './review-cases.js'

const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`Provide ${name} (1–2000 characters)`)
  return value.trim()
}

/** Create source-owned control review state. @returns {object} Preparation, validation, assessment, and disposal operations. */
export function createControlReview() {
  let draft = null, pending = null, closed = false
  function requireDraft(id) {
    if (closed || !draft || draft.id !== id) throw new Error('Controls changed or are no longer staged. Read the current meshState; prepare and validate again before presenting controls.')
    return draft
  }
  function cancel() {
    pending?.finish({ status: 'cancelled' })
    pending = null
  }
  return {
    prepare(value, identity) {
      if (closed) throw new Error('Control review is closed')
      const spec = normalizeShape(value)
      if (spec.operation === 'parameters') throw new Error('Executable parameter previews are disabled')
      const keys = spec.controls.flatMap(c => c.axes.map(a => a.key))
      if (!Array.isArray(value.expectations) || value.expectations.length !== keys.length || new Set(value.expectations.map(e => e.key)).size !== keys.length
        || value.expectations.some(e => !keys.includes(e.key))) throw new Error('Provide one expected effect and preserved feature description for each axis')
      const expectations = value.expectations.map(e => ({ key: e.key, effect: text(e.effect, 'expected effect'), preserve: text(e.preserve, 'features to preserve') }))
      if (spec.operation === 'fields' && Object.values(spec.values).some(v => v !== 0)) throw new Error('Prepare fields at neutral zero values')
      cancel()
      draft = { id: randomUUID(), identity: { ...identity }, spec, expectations, status: 'validation_required', ...controlReviewCases(spec) }
      return this.state()
    },
    state() {
      if (!draft) return null
      return { id: draft.id, status: draft.status, identity: draft.identity, expectations: draft.expectations,
        evidenceId: draft.evidenceId ?? null, report: draft.report ?? null, geometry: draft.geometry ?? null, assessments: draft.assessments ?? null,
        next: draft.status === 'validation_required' ? 'Call viewer_controls validate with this id.'
          : draft.status === 'awaiting_review' ? 'Inspect every evidence image, then call review with an assessment for every axis and combined effects.'
          : draft.status === 'approved' ? 'Call viewer_controls present with this id.'
          : draft.status === 'needs_revision' ? 'Revise the controls, then prepare and validate again.' : 'Wait for validation to finish.' }
    },
    geometryRequest(id) {
      requireDraft(id)
      return draft.spec.operation === 'surface' ? { spec: draft.spec, cases: draft.cases } : null
    },
    geometry(id, cases) {
      requireDraft(id)
      draft.geometry = cases
      if (cases.some(item => item.newIntersectionPairs > 0)) draft.status = 'needs_revision'
      return this.state()
    },
    request() { return pending ? { id: pending.id, draftId: draft.id, identity: draft.identity, spec: draft.spec, cases: draft.cases, neutral: draft.neutral } : null },
    validate(id, signal, timeoutMs) {
      requireDraft(id)
      if (pending) throw new Error('Control validation is already running')
      if (draft.spec.operation === 'surface' && (!draft.geometry || draft.geometry.some(item => item.newIntersectionPairs > 0))) throw new Error('Surface controls require passing host geometry checks before image validation')
      signal.throwIfAborted()
      draft.status = 'validating'; delete draft.report; delete draft.assessments; delete draft.evidenceId
      return new Promise(resolve => {
        const finish = result => {
          clearTimeout(timer); signal.removeEventListener('abort', abort); pending = null
          if (draft?.id === id && draft.status === 'validating') draft.status = 'validation_required'
          resolve(result)
        }
        const abort = () => finish({ status: 'cancelled' })
        const timer = setTimeout(() => finish({ status: 'validation_failed', message: `No complete evidence arrived within ${timeoutMs} ms. Prepared controls ${id} are retained. Retry viewer_controls validate with this id; reloading the model is unnecessary.` }), timeoutMs)
        pending = { id: randomUUID(), finish }
        signal.addEventListener('abort', abort, { once: true })
      })
    },
    deliver(id, result) {
      if (!pending || pending.id !== id) return false
      if (result?.status === 'failed') { pending.finish({ status: 'validation_failed', message: text(result.message, 'validation failure') }); return true }
      if (result?.status !== 'complete' || !Array.isArray(result.cases) || result.cases.length !== draft.cases.length) throw new Error('Incomplete control evidence')
      if (draft.spec.operation !== 'cut' && (!Number.isFinite(result.neutralMaxDisplacementMm) || result.neutralMaxDisplacementMm < 0 || result.neutralMaxDisplacementMm > .001)) throw new Error('Neutral controls must reproduce the saved mesh')
      const seen = new Set()
      for (const item of result.cases) {
        if (!draft.cases.some(c => c.id === item.id) || seen.has(item.id)) throw new Error('Evidence does not match the requested cases')
        seen.add(item.id)
        for (const key of ['maxDisplacementMm', 'rmsDisplacementMm', 'affectedFraction']) {
          if (!Number.isFinite(item[key]) || item[key] < 0 || (key === 'affectedFraction' && item[key] > 1)) throw new Error('Invalid displacement measurements')
        }
        if (typeof item.image !== 'string' || item.image.length > 4 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.image)) throw new Error('Evidence requires a PNG comparison for every case')
      }
      draft.status = 'storing_evidence'
      pending.finish({ status: 'complete', cases: result.cases.map(item => ({ id: item.id, maxDisplacementMm: item.maxDisplacementMm, rmsDisplacementMm: item.rmsDisplacementMm, affectedFraction: item.affectedFraction, image: item.image, warning: item.affectedFraction === 0 ? 'No surface vertices changed in this case.' : null, ...(draft.spec.operation === 'cut' ? { measurement: 'removed vertices', removedFraction: item.affectedFraction } : {}) })) })
      return true
    },
    evidence(id, report) {
      requireDraft(id)
      if (draft.status !== 'storing_evidence') throw new Error('Complete renderer validation before recording evidence')
      draft.report = report; draft.evidenceId = randomUUID(); draft.status = 'awaiting_review'
      return this.state()
    },
    review(id, evidenceId, assessments, combined) {
      requireDraft(id)
      if (draft.status !== 'awaiting_review' || draft.evidenceId !== evidenceId) throw new Error('Generate and inspect current evidence before reviewing')
      const keys = draft.expectations.map(e => e.key)
      if (!Array.isArray(assessments) || assessments.length !== keys.length || new Set(assessments.map(a => a.key)).size !== keys.length
        || assessments.some(a => !keys.includes(a.key) || !['accept', 'revise'].includes(a.decision))) throw new Error('Assess every control axis as accept or revise')
      const checked = assessments.map(a => ({ key: a.key, decision: a.decision, observation: text(a.observation, 'observed effect and preservation') }))
      if (!combined || !['accept', 'revise'].includes(combined.decision)) throw new Error('Assess combined extremes')
      draft.assessments = { axes: checked, combined: { decision: combined.decision, observation: text(combined.observation, 'combined effects') } }
      draft.status = [...checked, combined].every(a => a.decision === 'accept') ? 'approved' : 'needs_revision'
      return this.state()
    },
    present(id, identity) {
      requireDraft(id)
      if (draft.status !== 'approved') throw new Error('Validate the controls and review the images before presenting them')
      if (JSON.stringify(draft.identity) !== JSON.stringify(identity)) throw new Error('Model changed; prepare and validate again')
      return { ...draft.spec, ...draft.identity }
    },
    fail(id) { if (draft?.id === id && ['validating', 'storing_evidence'].includes(draft.status)) { cancel(); draft.status = 'validation_required' } },
    clear(id) { requireDraft(id); cancel(); draft = null },
    reset() { cancel(); draft = null },
    dispose() { cancel(); draft = null; closed = true },
  }
}
