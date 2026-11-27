/** Pure status and activity derivations for the 3D preview pane. */

export const ACTIVITY_LABELS = Object.freeze({
  building: 'activityBuilding',
  checking: 'activityChecking',
  sculpt: 'activitySculpt',
  regions: 'activityRegions',
  collision: 'activityCollision',
  fdm: 'activityFdm',
  mechanics: 'activityMechanics',
  look: 'activityLook',
  controls: 'activityControls',
})

const SPECIFIC_VALIDATION_ACTIVITIES = new Set(['collision', 'fdm', 'mechanics'])

/** Derive the visible work phase for the active scene. */
export function activityFor(scene) {
  if (!scene) return 'idle'
  const activeOnModel = scene.agentRunning && (!scene.workingModels?.length || scene.workingModels.includes(scene.selectedModel))
  const classified = activeOnModel && scene.agentActivity && Object.hasOwn(ACTIVITY_LABELS, scene.agentActivity) ? scene.agentActivity : null
  const item = scene.selectedModel ? scene.validation?.models.find(model => model.path === scene.selectedModel) : null
  if (item?.status === 'checking') return classified && SPECIFIC_VALIDATION_ACTIVITIES.has(classified) ? classified : 'checking'
  if (activeOnModel) return classified ?? 'building'
  return 'idle'
}

/** Derive the validation dot locale key for a loaded canonical design. */
export function printValidationLabel(scene) {
  const item = scene.validation?.models.find(model => model.path === scene.selectedModel)
  if (scene.validation?.error || item?.error || item?.status === 'unavailable') return 'validationUnavailable'
  if (!item) return 'layoutChecksMissing'
  if (item.status === 'changed' || item.sourceHash !== scene.design?.contentHash) return 'validationChanged'
  if (item.status === 'checking') return 'validationChecking'
  if (item.status === 'needs_repair') return 'validationRepair'
  if (item.report?.mechanics?.status === 'review') return 'validationMechanicsReview'
  if (item.report?.mechanics?.status === 'passed' && item.report.mechanics.assemblyVerified
    && item.report.mechanics.coverage?.complete && !item.report.checks.some(check => check.count)
    && item.acceptedFingerprint !== item.fingerprint) return 'validationChecksPassed'
  if (item.status === 'review') return 'validationReview'
  if (item.acceptedFingerprint === item.fingerprint) return 'layoutModelChecked'
  return 'layoutChecksMissing'
}

/** Derive the aggregate validation dot locale key when no single design is active. */
export function validationLabel(scene) {
  const validation = scene?.validation
  if (!validation) return null
  if (validation.error || validation.models.some(item => item.status === 'unavailable')) return 'validationUnavailable'
  if (validation.models.some(item => item.status === 'needs_repair'
    || (item.report ?? item.previousReport)?.status === 'needs_repair')) return 'validationRepair'
  if (validation.models.some(item => (item.report ?? item.previousReport)?.mechanics?.status === 'review')) return 'validationMechanicsReview'
  return null
}
