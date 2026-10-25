import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '../shared/ipcChannels'

type AudioMode = 'mic' | 'system' | 'both'

export interface ControlIpcDependencies {
  setRecordingState: (recording: boolean) => void
  setAudioMode: (mode: AudioMode) => void
  updateTrayMenu: () => void
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  deleteTempRecordingById: (recordingId: string) => Promise<boolean>
}

export function registerControlIpcHandlers(deps: ControlIpcDependencies): void {
  ipcMain.handle(IPC.invoke.control.appRelaunch, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    app.relaunch()
    app.quit()
  })

  ipcMain.handle(IPC.invoke.control.windowMinimize, (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    const win = BrowserWindow.getFocusedWindow()
    if (win && !win.isDestroyed()) win.minimize()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.control.windowToggleMaximize, (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    const win = BrowserWindow.getFocusedWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return { ok: true, maximized: win.isMaximized() }
    }
    return { ok: false }
  })

  ipcMain.handle(IPC.invoke.control.windowIsMaximized, (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked', maximized: false }
    }
    const win = BrowserWindow.getFocusedWindow()
    return { ok: true, maximized: win && !win.isDestroyed() ? win.isMaximized() : false }
  })

  ipcMain.handle(IPC.invoke.control.windowClose, (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    const win = BrowserWindow.getFocusedWindow()
    if (win && !win.isDestroyed()) {
      win.close()
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.control.trayUpdateRecordingState, async (_evt, recording: boolean) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    deps.setRecordingState(recording)
    deps.updateTrayMenu()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.control.trayUpdateAudioMode, async (_evt, mode: AudioMode) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    deps.setAudioMode(mode)
    deps.updateTrayMenu()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.control.zoomGet, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked', factor: 1 }
    }
    try {
      const factor = evt.sender.getZoomFactor()
      return { ok: true, factor }
    } catch {
      return { ok: false, factor: 1 }
    }
  })

  ipcMain.handle(IPC.invoke.control.zoomSet, async (evt, factor: number) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const clamped = Math.min(3, Math.max(0.5, Number(factor) || 1))
      evt.sender.setZoomFactor(clamped)
      return { ok: true, factor: evt.sender.getZoomFactor() }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle(IPC.invoke.control.zoomDelta, async (evt, delta: number) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      const cur = evt.sender.getZoomFactor()
      const next = Math.min(3, Math.max(0.5, cur + (Number(delta) || 0)))
      evt.sender.setZoomFactor(next)
      return { ok: true, factor: evt.sender.getZoomFactor() }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle(IPC.invoke.control.fileDelete, async (_evt, recordingId: string) => {
    try {
      if (!deps.isTrustedRendererEvent(_evt)) {
        return { ok: false, message: 'blocked' }
      }

      const deleted = await deps.deleteTempRecordingById(recordingId)
      if (!deleted) {
        return { ok: false, message: 'not found' }
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.control.log, async (_evt, msg: string) => {
    if (!deps.isTrustedRendererEvent(_evt)) {
      return { ok: false, message: 'blocked' }
    }
    deps.sendProgress(`[Renderer] ${msg}`)
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.control.openExternal, async (evt, url: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return { ok: false, message: 'blocked' }
    }
    try {
      if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:'))) {
        return { ok: false, message: 'blocked' }
      }
      await shell.openExternal(url)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) }
    }
  })
}
