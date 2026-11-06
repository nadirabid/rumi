/** Rumi presets retain upstream capabilities except structured questionnaires. */
import { createRequire } from 'node:module'
import { z } from 'zod'
import { loadOptionalPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'

export const inject = ['agentPresets']

/** Context pressure policy applied to each registered Rumi preset. */
export const Config = z.object({ compactionThresholdRatio: z.number().gt(0).lt(1) })

/**
 * Register the shipped presets with questions handled through conversation.
 * @param {object} ctx - Plugin context owning preset registrations.
 * @param {object} config - Validated Rumi compaction policy.
 */
export async function* apply(ctx, config) {
  const require = createRequire(import.meta.url)
  for (const id of ['standard', 'ptc', 'cordis']) {
    const path = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
    const patches = loadOptionalPatches('rumi', path)
    if (!patches) throw new Error(`Missing Rumi preset source: ${id}`)
    const rows = composeEntries([patches])
    const preset = rows.find(row => row.id === `preset-${id}`)
    if (!preset?.config?.plugins) throw new Error(`Missing Rumi preset definition: ${id}`)
    yield await ctx.agentPresets.register(configurePreset(preset.config, config.compactionThresholdRatio))
  }
}

/**
 * Apply Rumi's conversation and context-pressure policies to a shipped preset.
 * @param {object} preset - Shipped preset definition.
 * @param {number} thresholdRatio - Fraction of the model context window that triggers compaction.
 * @returns {object} Independent definition with the same persistent preset identity.
 */
export function configurePreset(preset, thresholdRatio) {
  const result = structuredClone(withoutQuestionnaire(preset))
  const group = result.plugins.find(row => row.id === 'compaction')
  const engine = group?.config?.find(row => row.name === '@deepseek-ai/dsh-compaction-basic')
  if (!engine) throw new Error(`Missing compaction engine in Rumi preset: ${preset.id}`)
  engine.config = { ...engine.config, thresholdRatio }
  return result
}

/**
 * Preserve a shipped preset while removing its questionnaire consumer.
 * @param {object} preset - Shipped preset definition.
 * @returns {object} Independent definition with the same persistent preset identity.
 */
export function withoutQuestionnaire(preset) {
  const plugins = preset.plugins.filter(row => row.name !== '@deepseek-ai/dsh-tool-ask-user')
  if (plugins.length === preset.plugins.length) throw new Error(`Missing questionnaire tool in preset: ${preset.id}`)
  return { ...preset, plugins }
}
