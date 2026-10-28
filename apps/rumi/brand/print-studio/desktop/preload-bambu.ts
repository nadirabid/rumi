/** Bambu's hosted sign-in page uses the wx WebView message interface. */
import { contextBridge, ipcRenderer } from 'electron'

if (location.origin === 'https://bambulab.com') {
  contextBridge.exposeInMainWorld('wx', {
    postMessage: (message: string) => { ipcRenderer.send('rumi:bambu:message', message) },
  })
}
