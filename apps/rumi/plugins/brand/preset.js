/** Reuse shipped definitions under Rumi's project-scoped tool and prompt policy. */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { loadOptionalPatches, composeEntries } from '@deepseek-ai/dsh-app-boot'

export const inject = ['agentPresets']

const unsupportedRows = new Set([
  'agent-instructions', 'tool-ask-user', 'tool-cordis', 'tool-office', 'tool-plugin-manager', 'tool-plugin-market', 'tool-executor-ptc',
])

/** Context pressure policy applied to each registered Rumi preset. */
export const Config = z.object({ compactionThresholdRatio: z.number().gt(0).lt(1) })

/** Resolve a shipped preset patch from installed dependencies or the workspace source tree. */
function resolvePresetPatch(id) {
  const specifier = `@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`
  const require = createRequire(import.meta.url)
  try {
    return require.resolve(specifier)
  } catch (resolutionError) {
    // Source checkouts invoked without pnpm's NODE_PATH do not link @deepseek-ai/dsh-web-app above apps/rumi/plugins/.
    const workspacePath = fileURLToPath(new URL(`../../../../packages/bundle/web-app/presets/${id}.patch.yml`, import.meta.url))
    if (existsSync(workspacePath)) return workspacePath
    throw resolutionError
  }
}

/**
 * Register the shipped preset identities with project-scoped capabilities.
 * @param {object} ctx - Plugin context owning preset registrations.
 * @param {object} config - Validated Rumi compaction policy.
 */
export async function* apply(ctx, config) {
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const path = resolvePresetPatch(id)
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
  const result = structuredClone({ ...preset, plugins: preset.plugins.filter(row => !unsupportedRows.has(row.id)) })
  const persona = result.plugins.find(row => row.id === 'persona')
  if (!persona) throw new Error(`Missing persona in Rumi preset: ${preset.id}`)
  // The complete Minimal persona would suppress the project's required prompt section.
  if (preset.id === 'minimal' || preset.id === 'cordis') {
    persona.config = { prefix: 'You are Rumi, a project tool powered by the {{model}} model.' }
  }
  const group = result.plugins.find(row => row.id === 'compaction')
  const engine = group?.config?.find(row => row.name === '@deepseek-ai/dsh-compaction-basic')
  if (!engine) throw new Error(`Missing compaction engine in Rumi preset: ${preset.id}`)
  engine.config = { ...engine.config, thresholdRatio }
  return result
}
