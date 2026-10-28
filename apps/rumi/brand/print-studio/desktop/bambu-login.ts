/** Isolated native window for the Bambu-hosted login page. Account storage belongs to Print Studio. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { BrowserWindow, ipcMain, shell } from 'electron'

/**
 * Bambu's hosted page parses a space-delimited Studio version before enabling ticket callbacks.
 * @param browserUserAgent Chromium's original user agent.
 * @returns The compatible Studio marker followed by the original browser information.
 */
export function bambuLoginUserAgent(browserUserAgent: string): string {
  return `BBL-Slicer/v02.08.02.61 ${browserUserAgent}`
}

/**
 * Open Bambu's login and return its login message to the requesting plugin.
 * @param parent Rumi window that owns the login attempt.
 * @param preload Sandboxed preload implementing Bambu's WebView message interface.
 * @returns Login message; rejects when the window closes or its deadline expires.
 */
export function openBambuLogin(parent: BrowserWindow, preload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({ parent, width: 520, height: 760, title: 'Bambu Lab',
      webPreferences: { preload, partition: `rumi-bambu-login-${randomUUID()}`, nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true } })
    window.webContents.setUserAgent(bambuLoginUserAgent(window.webContents.getUserAgent()))
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.session.on('will-download', event => event.preventDefault())
    const browserSession = window.webContents.session
    let settled = false
    let port = 0
    const finish = (message?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      parent.off('closed', close)
      ipcMain.off('rumi:bambu:message', receive)
      if (!window.isDestroyed()) window.destroy()
      void browserSession.clearStorageData().catch(() => undefined)
      if (message === undefined) reject(new Error('Bambu sign-in closed'))
      else {
        parent.show()
        parent.focus()
        resolve(message)
      }
    }
    const receive = (event: Electron.IpcMainEvent, message: unknown): void => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || new URL(event.senderFrame.url).origin !== 'https://bambulab.com'
        || typeof message !== 'string' || message.length > 65536) return
      let value: { command?: string; sequence_id?: string; data?: { url?: string } }
      try { value = JSON.parse(message) } catch { return }
      if (value === null || typeof value !== 'object') return
      if (value.command === 'user_login' || value.command === 'user_ticket_login') finish(message)
      else if (value.command === 'get_localhost_url') {
        const reply = { command: value.command, sequence_id: value.sequence_id,
          response: { base_url: `http://localhost:${port}`, result: 'success' } }
        void window.webContents.executeJavaScript(`window.postMessage(${JSON.stringify(JSON.stringify(reply))}, location.origin)`)
      } else if (value.command === 'thirdparty_login' || value.command === 'new_webpage') {
        const url = value.data?.url
        if (typeof url === 'string' && url.startsWith('https://')) void shell.openExternal(url)
      }
    }
    const close = (): void => finish()
    const server = createServer((request, response) => {
      const ticket = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ticket')
      if (!ticket) { response.writeHead(400).end(); return }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('You can return to Rumi.')
      finish(JSON.stringify({ command: 'user_ticket_login', data: { ticket } }))
    })
    server.on('error', close)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { finish(); return }
      port = address.port
      void window.loadURL('https://bambulab.com/en/sign-in').catch(() => finish())
    })
    const timer = setTimeout(() => finish(), 180_000)
    ipcMain.on('rumi:bambu:message', receive)
    window.on('closed', () => finish())
    parent.once('closed', close)
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== 'https://bambulab.com') event.preventDefault()
    })
    window.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== 'https://bambulab.com') event.preventDefault()
    })
  })
}
