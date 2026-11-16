/** Source-resolved Print Studio host, geometry, and renderer regressions. */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'], loose: true }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: ['apps/rumi/brand/print-studio/tests/*.spec.{ts,tsx}'],
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'],
  },
})
