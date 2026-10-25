import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipcChannels'

/**
 * Ask windows with note editors to save pending edits (their autosave is debounced) and wait
 * until each confirms or `timeoutMs` passes, so quitting or relaunching does not lose typing.
 */
export function flushNoteEdits(windows: Array<BrowserWindow | null>, timeoutMs = 1500): Promise<void> {
  const targets = windows.filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
  if (targets.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const waiting = new Set(targets.map((win) => win.webContents.id))
    const finish = () => {
      clearTimeout(timer)
      ipcMain.removeListener(IPC.send.rendererToMain.notesFlushed, onFlushed)
      resolve()
    }
    const onFlushed = (evt: Electron.IpcMainEvent) => {
      waiting.delete(evt.sender.id)
      if (waiting.size === 0) finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    ipcMain.on(IPC.send.rendererToMain.notesFlushed, onFlushed)
    for (const win of targets) win.webContents.send(IPC.event.mainToRenderer.notesFlush)
  })
}
