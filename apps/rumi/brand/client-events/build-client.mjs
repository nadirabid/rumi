/** Build the upstream Remote provider and browser consumer for the Rumi bundle. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
await build({
  absWorkingDir: root,
  entryPoints: [require.resolve('@deepseek-ai/dsh-client-hmr/src/plugin-events.ts')],
  outfile: 'lib/plugin-events.js',
  external: ['@deepseek-ai/dsh-typert-protocol'],
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
})
const client = await build({
  absWorkingDir: root,
  entryPoints: [require.resolve('@deepseek-ai/dsh-client-hmr/src/client/index.ts')],
  external: ['@deepseek-ai/dsh-api-gateway/client'],
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: true, write: false,
})
await writeFile(new URL('./lib/client.js', import.meta.url),
  `window.__ModuleLoader__.load({ id: '@rumi/client-events', factory(require) {
    const module = { exports: {} };
    ${client.outputFiles[0].text}
    return module.exports;
  } });\n`)
