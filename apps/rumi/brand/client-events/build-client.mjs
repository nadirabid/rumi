/** Bundle the stock client event transport under Rumi's host package identity. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(new URL('../../../../packages/bundle/web-app/package.json', import.meta.url))
await build({
  stdin: {
    contents: `import * as transport from '@deepseek-ai/dsh-client-hmr/src/client/index.ts';
      window.__ModuleLoader__.load({ id: '@rumi/client-events', factory() { return transport; } });`,
    resolveDir: root,
    sourcefile: 'client-events.js',
  },
  alias: { '@deepseek-ai/dsh-client-hmr/src/client/index.ts': require.resolve('@deepseek-ai/dsh-client-hmr/src/client/index.ts') },
  outfile: fileURLToPath(new URL('./lib/client.js', import.meta.url)),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
})
