import { BrowserWindow, ipcMain } from 'electron'
import { screenshotHelper } from './ScreenshotHelper'
import { IPC } from '../shared/ipcChannels'

interface ScreenshotIpcDependencies {
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
}

function findChatWindow(): BrowserWindow | undefined {
  try {
    return BrowserWindow.getAllWindows().find(window => {
      try {
        return window.webContents.getURL().includes('chat.html')
      } catch {
        return false
      }
    })
  } catch {
    return undefined
  }
}

export function registerScreenshotIpcHandlers(deps: ScreenshotIpcDependencies): void {
  // Screenshot operations
  ipcMain.handle(IPC.invoke.screenshot.capture, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const screenshot = await screenshotHelper.captureScreenshot()
      if (screenshot) {
        return { ok: true, screenshot }
      } else {
        return { ok: false, message: 'Screenshot capture failed' }
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.list, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const screenshots = screenshotHelper.getScreenshots()
      return { ok: true, screenshots }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.get, async (_evt, id: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const screenshot = screenshotHelper.getScreenshot(id)
      if (screenshot) {
        return { ok: true, screenshot }
      } else {
        return { ok: false, message: 'Screenshot not found' }
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.delete, async (_evt, id: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const success = await screenshotHelper.deleteScreenshot(id)
      return { ok: success }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.clear, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      await screenshotHelper.clearAllScreenshots()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.getData, async (_evt, id: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const data = await screenshotHelper.getScreenshotData(id)
      if (data) {
        return { ok: true, data: data.toString('base64') }
      } else {
        return { ok: false, message: 'Screenshot data not found' }
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.getBase64, async (_evt, id: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const base64 = await screenshotHelper.getScreenshotBase64(id)
      if (base64) {
        return { ok: true, base64 }
      } else {
        return { ok: false, message: 'Screenshot not found' }
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.getConfig, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const config = screenshotHelper.getConfig()
      return { ok: true, config }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.screenshot.updateConfig, async (_evt, config: any) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      screenshotHelper.updateConfig(config)
      return { ok: true, config: screenshotHelper.getConfig() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // Screenshot selection for chat
  ipcMain.handle(IPC.invoke.screenshot.selectForChat, async (_evt, id: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const screenshot = screenshotHelper.getScreenshot(id)
      if (!screenshot) {
        return { ok: false, message: 'Screenshot not found' }
      }

      const chatWindow = findChatWindow()

      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send(IPC.event.mainToRenderer.screenshotSelected, {
          id: screenshot.id,
          filePath: screenshot.filePath,
          timestamp: screenshot.timestamp
        })
        return { ok: true }
      } else {
        return { ok: false, message: 'Chat window not found' }
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
