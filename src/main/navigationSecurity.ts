import type { WebContents } from 'electron'
import { shell } from 'electron'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_PAGES = new Set([
  'index.html', 'chat.html', 'notes-float.html', 'prompt.html',
  'hud.html', 'toast.html', 'permissions.html',
])

export function isTrustedAppUrl(url: string, appRoot: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    const filePath = fileURLToPath(parsed)
    const relative = path.relative(path.resolve(appRoot), filePath)
    return APP_PAGES.has(relative)
  } catch {
    return false
  }
}

export function isTrustedAppFrame(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, appRoot: string): boolean {
  try {
    return event.senderFrame === event.sender.mainFrame && isTrustedAppUrl(event.senderFrame.url, appRoot)
  } catch {
    return false
  }
}

export function guardAppNavigation(contents: WebContents, appRoot: string): void {
  const openExternal = (url: string) => {
    try {
      const parsed = new URL(url)
      if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
        void shell.openExternal(url).catch(() => {})
      }
    } catch { }
  }
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url, appRoot)) return
    event.preventDefault()
    openExternal(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedAppUrl(url, appRoot)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
