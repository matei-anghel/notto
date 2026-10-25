import { dialog, ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import { IPC } from '../shared/ipcChannels'
import { DatabaseManager } from './DatabaseManager'

interface DataIpcDependencies {
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
}

export function registerDataIpcHandlers(deps: DataIpcDependencies): void {
  ipcMain.handle(IPC.invoke.data.exportSaveAs, async (evt, params: { suggestedName?: string; text: string; filters?: { name: string; extensions: string[] }[] }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const res = await dialog.showSaveDialog({
        title: 'Save export',
        defaultPath: params.suggestedName || 'export.txt',
        filters: params.filters && params.filters.length ? params.filters : [
          { name: 'Text Files', extensions: ['txt'] },
          { name: 'Markdown', extensions: ['md'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (res.canceled || !res.filePath) return { ok: false, message: 'Save canceled' }
      await fsp.writeFile(res.filePath, params.text ?? '', 'utf8')
      return { ok: true, path: res.filePath }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.statsGet, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ stats: null })
    }
    try {
      return DatabaseManager.getInstance().getStats()
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.statsUpdate, async (evt, update: { wordsDictated?: number; dictationTimeSeconds?: number; meetingsTranscripted?: number }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().updateStats(update)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.statsReset, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().resetStats()
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.dbSaveChat, async (evt, data: { id: string; title: string; messages: any[] }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().saveChat(data.id, data.title, data.messages)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.dbGetHistory, async (evt, params: { limit: number; offset: number }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ chats: [] as any[] })
    }
    try {
      return DatabaseManager.getInstance().getHistory(params?.limit || 50, params?.offset || 0)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.dbGetChat, async (evt, id: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ chat: null })
    }
    try {
      return DatabaseManager.getInstance().getChat(id)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.dbDeleteChat, async (evt, id: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().deleteChat(id)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.dbSearch, async (evt, query: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ chats: [] as any[] })
    }
    try {
      return DatabaseManager.getInstance().searchChats(query)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.activityGet, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ logs: [] as any[] })
    }
    try {
      return DatabaseManager.getInstance().getActivityLogs()
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.activityAdd, async (evt, log: { text: string; icon: string; type?: string; fullText?: string; durationSeconds?: number }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().addActivityLog(log)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.data.activityDelete, async (evt, timestamp: number) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      return DatabaseManager.getInstance().deleteActivityLog(timestamp)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
