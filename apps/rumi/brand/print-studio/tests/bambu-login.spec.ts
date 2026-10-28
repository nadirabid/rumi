/** Native Bambu login dispatch and loopback callback ownership. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  windows: [] as Array<{
    webContents: EventEmitter & { mainFrame: { url: string }; executeJavaScript: ReturnType<typeof vi.fn> }
    destroyed: boolean
    emit: (event: string) => boolean
  }>,
  loaded: undefined as (() => void) | undefined,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'https://bambulab.com/en/sign-in' },
      getUserAgent: () => 'Mozilla/5.0 Electron/44.7.0',
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined),
      session: {
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn(),
        clearStorageData: vi.fn(async () => undefined),
      },
    })
    constructor() { super(); native.windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    show = vi.fn()
    focus = vi.fn()
    async loadURL() { native.loaded?.() }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter(), shell: { openExternal: vi.fn(async () => undefined) } }
})

import { BrowserWindow, ipcMain } from 'electron'
import { bambuLoginUserAgent, openBambuLogin } from '../desktop/bambu-login.ts'

afterEach(() => {
  for (const window of native.windows.splice(0)) window.emit('closed')
  native.loaded = undefined
})

it('advertises a Studio version recognized by Bambu’s space-delimited version parser', () => {
  const userAgent = bambuLoginUserAgent('Mozilla/5.0 Electron/44.7.0')
  // This is the version extraction used by Bambu's hosted sign-in page.
  expect(/BBL-Slicer\/v(.+?) /.exec(userAgent)?.[1]).toBe('02.08.02.61')
  expect(userAgent).toContain('Mozilla/5.0 Electron/44.7.0')
})

it('returns a browser ticket and removes the callback listener after completion', async () => {
  const parent = new BrowserWindow()
  const loaded = Promise.withResolvers<void>()
  native.loaded = () => loaded.resolve()
  const login = openBambuLogin(parent, '/fixture/preload-bambu.cjs')
  const window = native.windows.at(-1)!
  try {
    await loaded.promise
    ipcMain.emit('rumi:bambu:message', { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      JSON.stringify({ command: 'get_localhost_url', sequence_id: 'test' }))
    const script = window.webContents.executeJavaScript.mock.calls[0]![0] as string
    const reply = JSON.parse(JSON.parse(script.slice('window.postMessage('.length, -', location.origin)'.length)))
    const callback = new URL(reply.response.base_url)
    // Bambu's callback rejects equivalent loopback IPs unless the URL uses "localhost".
    expect(/^http:\/\/localhost:\d+$/.test(reply.response.base_url)).toBe(true)
    callback.searchParams.set('ticket', 'test-ticket')
    expect((await fetch(callback)).status).toBe(200)
    await expect(login).resolves.toBe(JSON.stringify({ command: 'user_ticket_login', data: { ticket: 'test-ticket' } }))
    expect(window.destroyed).toBe(true)
    expect(ipcMain.listenerCount('rumi:bambu:message')).toBe(0)
    expect(parent.listenerCount('closed')).toBe(0)
    expect(parent.show).toHaveBeenCalledOnce()
    expect(parent.focus).toHaveBeenCalledOnce()
    await expect(fetch(callback)).rejects.toThrow()
  } finally {
    window.emit('closed')
    await login.catch(() => undefined)
    parent.destroy()
  }
})
