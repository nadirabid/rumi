/**
 * Vitest configuration for the Rumi release checks.
 *
 * The shared configuration maps `@deepseek-ai/*` imports to workspace sources
 * through tsconfig paths, but that mapping ignores `.js` importers unless the
 * tsconfig sets `allowJs`. Rumi's brand plugins ship as plain `.js`, so their
 * workspace imports would otherwise resolve only through whatever pnpm linked
 * into an ancestor `node_modules`, which a clean checkout does not have.
 *
 * Each test project needs its own instance because Vitest builds every inline
 * project as a separate server, and a root-level plugin does not reach it.
 */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import shared from '../../vitest.config.ts'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

/** The shared source-plane mapping, applied to importers of every extension. */
const loosePaths = () => tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true })

/** One shared test project with the loose mapping appended to its plugins. */
const withLoosePaths = (project: { plugins?: unknown[] }) => ({
  ...project,
  plugins: [...(project.plugins ?? []), loosePaths()],
})

export default {
  ...shared,
  root: repositoryRoot,
  plugins: [...(shared.plugins ?? []), loosePaths()],
  test: {
    ...shared.test,
    projects: (shared.test?.projects ?? []).map(withLoosePaths),
  },
}
