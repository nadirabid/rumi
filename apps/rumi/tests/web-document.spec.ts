import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { authenticateWebHost, DesktopUpdateReadGate, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('releases an idle long poll for update admission, preserves a write, and admits reads after recovery', async () => {
  const readEntered = Promise.withResolvers<undefined>()
  const readClosed = Promise.withResolvers<undefined>()
  const writeEntered = Promise.withResolvers<undefined>()
  const finishWrite = Promise.withResolvers<undefined>()
  let reads = 0
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      writeEntered.resolve(undefined)
      void finishWrite.promise.then(() => { response.end('saved') })
    } else if (++reads === 1) {
      response.once('close', () => { readClosed.resolve(undefined) })
      readEntered.resolve(undefined)
    } else response.end('resumed')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing TCP address')
  const host = `http://127.0.0.1:${address.port}`
  const gate = new DesktopUpdateReadGate()
  const reading = gate.forward(new Request('dsh-app://app/events'), host, 'session=test')
  const writing = gate.forward(new Request('dsh-app://app/save', { method: 'POST', body: 'edit' }), host, 'session=test')
  try {
    await Promise.all([readEntered.promise, writeEntered.promise])
    gate.pause()
    expect((await reading).status).toBe(503)
    await readClosed.promise
    expect((await gate.forward(new Request('dsh-app://app/events'), host, 'session=test')).status).toBe(503)
    expect(reads).toBe(1)
    finishWrite.resolve(undefined)
    expect(await (await writing).text()).toBe('saved')
    gate.resume()
    expect(await (await gate.forward(new Request('dsh-app://app/events'), host, 'session=test')).text()).toBe('resumed')
  } finally {
    gate.pause()
    finishWrite.resolve(undefined)
    await Promise.allSettled([reading, writing])
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('drops connection-level headers the Host wrote for its own transport', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('body', { headers: {
    'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5', trailer: 'x', te: 'trailers',
    'content-type': 'text/plain', 'cache-control': 'no-cache', etag: '"1"',
  } }))
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read'), 'http://127.0.0.1:1234/', 'session=owned')
  for (const name of ['transfer-encoding', 'connection', 'keep-alive', 'trailer', 'te']) expect(response.headers.get(name)).toBeNull()
  expect(response.headers.get('content-type')).toBe('text/plain')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('etag')).toBe('"1"')
})

it('replaces the immutable cache header of plugin bundles with no-store and leaves other routes alone', async () => {
  const immutable = 'public, max-age=31536000, immutable'
  const fetch = vi.fn().mockImplementation(async () => new Response('js', { headers: { 'cache-control': immutable } }))
  vi.stubGlobal('fetch', fetch)
  const bundle = await forwardWebRequest(new Request('dsh-app://app/plugins/??a/client.js&rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(bundle.headers.get('cache-control')).toBe('no-store')
  const chunk = await forwardWebRequest(new Request('dsh-app://app/plugins/a/client.x.js?rev=1'), 'http://127.0.0.1:1234/', 'c')
  expect(chunk.headers.get('cache-control')).toBe('no-store')
  const asset = await forwardWebRequest(new Request('dsh-app://app/api/plugins/list'), 'http://127.0.0.1:1234/', 'c')
  expect(asset.headers.get('cache-control')).toBe(immutable)
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})
