/**
 * Build the plugin's browser payload.
 *
 * This is the one Cordis row that ships a renderer, so it is also the one row
 * that is built rather than served as plain JS: Three.js is bundled privately
 * here and never enters the shared client module table. `esbuild` and `three`
 * are development dependencies of `apps/rumi`, which is why this script
 * resolves them from above the plugin directory.
 */
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)

/** Walk up from Three's entry point to the package root that holds its LICENSE. */
function packageRoot(entry) {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory
    if (dirname(directory) === directory) throw new Error(`could not locate the package root above ${entry}`)
  }
}

await mkdir(join(root, 'lib'), { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: ['client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  loader: { '.css': 'text', '.module.css': 'text' },
})
await copyFile(join(packageRoot(require.resolve('three')), 'LICENSE'), join(root, 'lib/THREE-LICENSE.txt'))
