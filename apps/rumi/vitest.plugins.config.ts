/** Source-resolved unit and client regressions for all Rumi plugins under `apps/rumi/plugins/`. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const piAiDist = join(repositoryRoot, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist')

const piAiResolve = {
  name: 'rumi-pi-ai-resolve',
  resolveId(source: string) {
    if (source === '@earendil-works/pi-ai') return join(piAiDist, 'index.js')
    if (source.startsWith('@earendil-works/pi-ai/')) return join(piAiDist, `${source.slice('@earendil-works/pi-ai/'.length)}.js`)
    return null
  },
}

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true }), piAiResolve, standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: [
      'apps/rumi/plugins/*/tests/*.spec.{ts,tsx}',
      'apps/rumi/tests/live-voice.spec.ts',
    ],
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
  },
})
