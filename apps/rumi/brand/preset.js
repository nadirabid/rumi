/** Rumi presets retain upstream capabilities except structured questionnaires. */
import { createRequire } from 'node:module'
import { loadOptionalPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'

export const inject = ['agentPresets']

/**
 * Register the shipped presets with questions handled through conversation.
 * @param {object} ctx - Plugin context owning preset registrations.
 */
export async function* apply(ctx) {
  const require = createRequire(import.meta.url)
  for (const id of ['standard', 'ptc', 'cordis']) {
    const path = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
    const patches = loadOptionalPatches('rumi', path)
    if (!patches) throw new Error(`Missing Rumi preset source: ${id}`)
    const rows = composeEntries([patches])
    const preset = rows.find(row => row.id === `preset-${id}`)
    if (!preset?.config?.plugins) throw new Error(`Missing Rumi preset definition: ${id}`)
    yield await ctx.agentPresets.register(withoutQuestionnaire(preset.config))
  }
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
