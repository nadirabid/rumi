/** Bundle stock picker styles and shared interactions with Rumi's speed pane. */
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
const stock = fileURLToPath(new URL('../../../../packages/client/ui-model-selection/src/client/', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'rumi-model-picker-'))
try {
  await copyFile(join(stock, 'ModelSelect.tsx'), join(temp, 'ModelSelect.tsx'))
  execFileSync('git', ['apply', '--no-index', join(root, 'ModelSelect.patch')], { cwd: temp })
  const result = await build({ absWorkingDir: root, entryPoints: ['client.tsx'], bundle: true,
    write: false, outfile: 'client.js', format: 'cjs', jsx: 'automatic', minifyWhitespace: true, minifySyntax: true,
    alias: { 'rumi-composer-speed': join(root, 'speed.ts') },
    plugins: [{ name: 'rumi-picker', setup(builder) {
      builder.onResolve({ filter: /^rumi-composer-select$/ }, () => ({ path: join(temp, 'ModelSelect.tsx'), namespace: 'picker' }))
      builder.onLoad({ filter: /.*/, namespace: 'picker' }, async args => ({
        contents: await readFile(args.path, 'utf8'), loader: 'tsx', resolveDir: stock,
      }))
    } }],
    external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
  const css = result.outputFiles.find(file => file.path.endsWith('.css')).text
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
  await mkdir(new URL('lib/', import.meta.url), { recursive: true })
  await writeFile(new URL('lib/client.js', import.meta.url),
    `window.__ModuleLoader__.load({id:"@rumi/model-picker",factory(require){const module={exports:{}};${js}
  const plugin=module.exports;return {inject:plugin.inject,apply(ctx){ctx.effect(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);return ()=>style.remove()});return plugin.apply(ctx)}}}});\n`)
} finally { await rm(temp, { recursive: true, force: true }) }
