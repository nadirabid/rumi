/**
 * Build all bundled Rumi plugins under `apps/rumi/plugins/`.
 *
 * Each browser plugin targets DSH's `window.__ModuleLoader__` registry, sharing
 * React and `@deepseek-ai/dsh-*` modules from the shell while bundling private
 * dependencies (such as Three.js) locally.
 */
import { build } from 'esbuild'
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGINS_ROOT = join(APP_ROOT, 'plugins')
const require = createRequire(import.meta.url)

/** Write a build output atomically so concurrent test workers never read a truncated bundle. */
async function writeFileAtomic(target, content) {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, target)
}

/** Walk up from a package entry point to the package root holding its LICENSE. */
function packageRoot(entry) {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory
    if (dirname(directory) === directory) throw new Error(`build-plugins: could not locate package root above ${entry}`)
  }
}

/**
 * Wrap a CJS esbuild output (and optional extracted CSS) in DSH's `__ModuleLoader__` format.
 * @param {string} id - Module id registered with the shell.
 * @param {string} js - Compiled CommonJS module body.
 * @param {string} [css] - Optional stylesheet injected via `ctx.effect` on apply.
 * @returns {string} Self-registering browser bundle.
 */
function wrapModuleLoader(id, js, css = '') {
  if (!css) {
    return `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory(require) {\n  const module = { exports: {} };\n  ${js}\n  return module.exports;\n} });\n`
  }
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory(require) {\n  const module = { exports: {} };\n  ${js}\n  const plugin = module.exports;\n  return { ...plugin, apply(ctx) {\n    ctx.effect(() => {\n      const style = document.createElement('style');\n      style.textContent = ${JSON.stringify(css)};\n      document.head.append(style);\n      return () => style.remove();\n    }, ${JSON.stringify(`${id}: styles`)});\n    return plugin.apply(ctx);\n  } };\n} });\n`
}

/** Shared helper for TSX/TS client plugins wrapped in `__ModuleLoader__`. */
export async function buildWrappedClient({ dir, id, entry, external, jsx = 'transform', cssInject = true }) {
  const root = join(PLUGINS_ROOT, dir)
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: 'client.js',
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx,
    minify: true,
    external,
    ...(cssInject ? {} : { loader: { '.css': 'text', '.module.css': 'text' } }),
  })
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = cssInject ? (result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '') : ''
  await writeFileAtomic(join(root, 'lib/client.js'), wrapModuleLoader(id, js, css))
}

const BUILDERS = {
  brand: () => buildWrappedClient({
    dir: 'brand',
    id: '@rumi/brand',
    entry: 'client/index.tsx',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'],
  }),

  projects: () => buildWrappedClient({
    dir: 'projects',
    id: '@rumi/projects',
    entry: 'client/index.tsx',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  }),

  'live-voice': () => buildWrappedClient({
    dir: 'live-voice',
    id: '@rumi/live-voice',
    entry: 'client/index.tsx',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  }),

  'model-picker': () => buildWrappedClient({
    dir: 'model-picker',
    id: '@rumi/model-picker',
    entry: 'client.tsx',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  }),

  'client-events': async () => {
    const root = join(PLUGINS_ROOT, 'client-events')
    await mkdir(join(root, 'lib'), { recursive: true })
    await build({
      absWorkingDir: root,
      entryPoints: [require.resolve('@deepseek-ai/dsh-client-hmr/src/plugin-events.ts')],
      outfile: 'lib/plugin-events.js',
      external: ['@deepseek-ai/dsh-typert-protocol'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
    })
    const client = await build({
      absWorkingDir: root,
      entryPoints: [require.resolve('@deepseek-ai/dsh-client-hmr/src/client/index.ts')],
      external: ['@deepseek-ai/dsh-api-gateway/client'],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
    })
    await writeFileAtomic(join(root, 'lib/client.js'), wrapModuleLoader('@rumi/client-events', client.outputFiles[0].text))
  },

  'print-studio': async () => {
    const root = join(PLUGINS_ROOT, 'print-studio')
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
      publicPath: 'plugins/@rumi/print-studio',
      assetNames: 'assets/badges/[name]-[hash]',
      loader: { '.css': 'text', '.module.css': 'text', '.webp': 'file' },
    })
    await copyFile(join(packageRoot(require.resolve('three')), 'LICENSE'), join(root, 'lib/THREE-LICENSE.txt'))
  },
}

/**
 * Build all registered Rumi plugins (or one named plugin).
 * @param {string} [only] Optional plugin directory name to build.
 * @returns {Promise<void>}
 */
export async function buildPlugins(only) {
  if (only !== undefined) {
    const task = BUILDERS[only]
    if (!task) throw new Error(`build-plugins: unknown plugin ${JSON.stringify(only)}; expected ${Object.keys(BUILDERS).join(', ')}`)
    await task()
    return
  }
  await Promise.all(Object.values(BUILDERS).map(task => task()))
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const only = process.argv[2]
  await buildPlugins(only)
}
