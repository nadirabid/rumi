/** Bundle Rumi's model-menu options and their styles. */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['client.tsx'],
  outfile: 'client.js',
  bundle: true,
  write: false,
  format: 'cjs',
  jsx: 'automatic',
  minify: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
})
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
await mkdir(new URL('lib/', import.meta.url), { recursive: true })
await writeFile(new URL('lib/client.js', import.meta.url),
  `window.__ModuleLoader__.load({ id: '@rumi/model-picker', factory(require) {
    const module = { exports: {} };
    ${js}
    const plugin = module.exports;
    return { inject: plugin.inject, apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.append(style);
        return () => style.remove();
      });
      return plugin.apply(ctx);
    } };
  } });\n`)
