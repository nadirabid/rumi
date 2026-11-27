/**
 * Vitest configuration for the Rumi release checks.
 *
 * The shared configuration maps `@deepseek-ai/*` imports to workspace sources
 * through tsconfig paths, but that mapping ignores `.js` importers unless the
 * tsconfig sets `allowJs`. Rumi's plugins include plain `.js` host modules, so
 * their workspace imports would otherwise resolve only through whatever pnpm
 * linked into an ancestor `node_modules`.
 *
 * Each test project needs its own instance because Vitest builds every inline
 * project as a separate server, and a root-level plugin does not reach it.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import shared from '../../vitest.config.ts'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const piAiDist = join(repositoryRoot, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist')

/** Resolve transitive runtime-only `@earendil-works/pi-ai/*` imports from `llm-pi-ai` in clean checkouts. */
const piAiResolve = () => ({
  name: 'rumi-pi-ai-resolve',
  resolveId(source: string) {
    if (source === '@earendil-works/pi-ai') return join(piAiDist, 'index.js')
    if (source.startsWith('@earendil-works/pi-ai/')) return join(piAiDist, `${source.slice('@earendil-works/pi-ai/'.length)}.js`)
    return null
  },
})

/** The shared source-plane mapping, applied to importers of every extension. */
const loosePaths = () => tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true })

/** One shared test project with the loose mapping appended to its plugins. */
const withLoosePaths = (project: { plugins?: unknown[] }) => ({
  ...project,
  plugins: [...(project.plugins ?? []), loosePaths(), piAiResolve()],
})

export default {
  ...shared,
  root: repositoryRoot,
  plugins: [...(shared.plugins ?? []), loosePaths(), piAiResolve()],
  test: {
    ...shared.test,
    projects: (shared.test?.projects ?? []).map(withLoosePaths),
  },
}
