/** Print Studio follows DSH's package-root bundle manifest conventions. */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

it('declares the bundle, client, patch, locale, icon, and runtime files', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  expect(manifest.main).toBe('index.js')
  expect(manifest.icon).toBe('./icon.svg')
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.dsh.client.platform).toBe('web')
  expect(manifest.exports['./client']).toBe('./client.js')
  expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
  expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
  expect(manifest.exports['./icon']).toBe('./icon.svg')
  expect(manifest.files).toEqual(expect.arrayContaining([
    'index.js', 'client.js', 'slicer.js', 'connect.js', 'monitor.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'lib/desktop', 'assets',
  ]))
})

it('ships readable inventory metadata and a valid icon', () => {
  for (const [locale, title] of [['en', 'Print Studio'], ['zh', '打印工作室']]) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')).meta
    expect(meta.title).toBe(title)
    expect(meta.description.length).toBeGreaterThan(10)
  }
  const icon = join(root, 'icon.svg')
  expect(readFileSync(icon, 'utf8')).toContain('<svg')
  expect(statSync(icon).size).toBeLessThan(256 * 1024)
})
