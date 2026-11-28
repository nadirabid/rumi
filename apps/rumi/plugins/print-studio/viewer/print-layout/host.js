/** Project-owned print layouts and an explicit, non-printing handoff to Bambu Studio. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { detectSlicer } from '../../printer/probe.js'
import { MAX_PRINT_PLATE_BYTES } from './plate-payload.js'
import { makePrint3mf } from './three-mf.js'
import { parsePrintLayout, printLayoutIdentity } from './state.js'

const run = promisify(execFile)
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** Read revision-bound layout data without following a saved-state symlink.
 * @param {string} cwd Canonical project directory.
 * @param {string} model Project-relative model entry.
 * @returns {Promise<object|null>} Parsed saved layout, or null when none exists.
 */
export async function readPrintLayout(cwd, model) {
  const path = layoutPath(cwd, model)
  let info
  try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.size > 512_000) throw new Error('Invalid saved print layout')
  return parsePrintLayout(JSON.parse(await readFile(path, 'utf8')))
}
function layoutPath(cwd, model) { return join(cwd, `.rumi-print-layout-${createHash('sha256').update(model).digest('hex')}.json`) }

/** Save one model's complete layout atomically; the source model is never changed.
 * @param {string} cwd Project directory.
 * @param {string} model Project-relative entry.
 * @param {object} layout Validated placement.
 * @returns {Promise<void>} Resolves after durable replacement.
 */
export async function savePrintLayout(cwd, model, layout) {
  await writeFileAtomic(layoutPath(await realpath(cwd), model), JSON.stringify(parsePrintLayout(layout)) + '\n', { mode: 0o600 })
}

/** Register print preparation with the viewer's serialized, session-scoped source owner.
 * @param {object} ctx Plugin context.
 * @param {Function} withSource Runs an operation with the current source, project and model entry.
 * @param {object} options Resolved default plate and spacing; scene volume takes precedence.
 * @returns {void}
 */
export function registerPrintLayout(ctx, withSource, options) {
  for (const operation of ['layout', 'open-plate']) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/print-studio/viewer/${operation}`, methods: operation === 'layout' ? ['GET', 'POST'] : ['POST'], requestBody: 'buffered',
    fetch: async request => {
      const query = new URL(request.url).searchParams, sessionId = query.get('sessionId')
      if (!sessionId) return json({ error: 'session_required' }, 400)
      try {
        return await withSource(sessionId, async ({ design, cwd, model, volume, requiresSeparatePrint, validationStatus = 'unverified' }) => {
          if (requiresSeparatePrint) return json({ error: 'layoutSeparateRequired' }, 409)
          const resolved = { volume: volume ?? options.volume, gap: options.gap }
          const identity = printLayoutIdentity(design, resolved.volume)
          if (operation === 'layout' && request.method === 'GET') {
            const saved = query.get('fresh') === '1' ? null : await readPrintLayout(cwd, model)
            return json({ options: resolved, layout: saved?.identity === identity ? saved : null, stale: Boolean(saved && saved.identity !== identity), validationStatus })
          }
          if (query.get('sourceHash') !== design.contentHash || design.analog) return json({ error: 'layoutChanged' }, 409)
          if (operation === 'layout') {
            const body = await request.text()
            if (body.length > 512_000) return json({ error: 'layoutFailed' }, 413)
            let layout
            try { layout = parsePrintLayout(JSON.parse(body)) } catch (_error) { return json({ error: 'layoutFailed' }, 400) }
            if (layout.identity !== identity) return json({ error: 'layoutChanged' }, 409)
            await savePrintLayout(cwd, model, layout)
            return json({ ok: true })
          }
          const body = await request.arrayBuffer()
          if (body.byteLength > MAX_PRINT_PLATE_BYTES) return json({ error: 'layoutFailed' }, 413)
          let bytes
          try {
            const form = await new Response(body, { headers: request.headers }).formData()
            bytes = await makePrint3mf(form, resolved.volume)
          } catch (error) {
            return json({ error: error.message === 'layoutOutside' ? 'layoutOutside' : 'layoutFailed' }, 400)
          }
          const slicer = detectSlicer()
          if (!slicer.found) return json({ error: 'layoutSlicerMissing' }, 409)
          const directory = await mkdtemp(join(await realpath(cwd), '.rumi-print-'))
          const file = join(directory, 'plate.3mf')
          await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
          try { await run('/usr/bin/open', ['-a', slicer.path, file], { timeout: 15_000, signal: request.signal, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key))) }) }
          catch (_error) { return json({ error: 'layoutOpenFailed' }, 502) }
          try {
            await writeFileAtomic(join(await realpath(cwd), '.rumi-print-handoff.json'),
              JSON.stringify({ model, sourceHash: design.contentHash, validationStatus, openedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
          } catch (_handoffReceiptError) { /* Handoff already opened in Bambu Studio; keep receipt recording best-effort. */ }
          return json({ ok: true, validationStatus })
        })
      } catch (_error) { return json({ error: 'layoutFailed' }, 409) }
    },
  }), `print viewer: ${operation}`)
}
