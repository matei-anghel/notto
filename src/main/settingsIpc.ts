import { app, dialog, ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { IPC } from '../shared/ipcChannels'
import { DEFAULT_MEETING_APPS, getMeetingAppCategories } from './MicWatcher/meetingApps'
import { keyboardShortcuts } from './keyboardShortcuts'
import { holdShortcuts } from './holdShortcuts'
import { getLogFilePath } from './logging'
import { applyLoginItemSettings } from './loginItem'

interface SettingsIpcDependencies {
  getPrefs: () => any
  savePrefs: () => void
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
  getMainWindow: () => Electron.BrowserWindow | null
  getChatWindow: () => Electron.BrowserWindow | null
  getNotesFloatWindow: () => Electron.BrowserWindow | null
  applyChatStealthMode: () => void
  applyNotesStealthMode: () => void
  toggleChatClickThrough: () => void
  updateMicWatcherIgnoredApps: (apps: string[]) => void
  playCueTest: () => Promise<void> | void
}

function ensureIgnoredMicApps(prefs: any): string[] {
  const next = Array.isArray(prefs.ignoredMicApps)
    ? prefs.ignoredMicApps
    : Array.isArray(prefs.customMeetingApps)
      ? prefs.customMeetingApps
      : []

  prefs.ignoredMicApps = next
  if ('customMeetingApps' in prefs) {
    delete prefs.customMeetingApps
  }
  return prefs.ignoredMicApps
}

/** "notesToggle" → "notes toggle" for user-facing messages. */
function describeShortcutAction(action: string): string {
  return action.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/\bai\b/g, 'AI')
}

export function registerSettingsIpcHandlers(deps: SettingsIpcDependencies): void {
  ipcMain.handle(IPC.invoke.settings.prefsUpdate, async (evt, next: Partial<{ chatTranslucence: number; chatOverlayHoverable: boolean; chatOverlayMinimal: boolean; chatOverlayTextCursor: boolean }>) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    try {
      const prefs = deps.getPrefs()

      if (typeof (next as any).cueVisual === 'boolean') prefs.cueVisual = (next as any).cueVisual
      if (typeof (next as any).cueAudio === 'boolean') prefs.cueAudio = (next as any).cueAudio
      if (typeof (next as any).cueVolume === 'number') prefs.cueVolume = (next as any).cueVolume
      if (typeof (next as any).keepRecordings === 'boolean') prefs.keepRecordings = (next as any).keepRecordings
      if (typeof (next as any).meetingAware === 'boolean') prefs.meetingAware = (next as any).meetingAware
      if (typeof (next as any).chatAlwaysOn === 'boolean') prefs.chatAlwaysOn = (next as any).chatAlwaysOn
      if (typeof (next as any).dictationLanguage === 'string') prefs.dictationLanguage = (next as any).dictationLanguage
      if (typeof (next as any).chatOverlayHoverable === 'boolean') {
        prefs.chatOverlayHoverable = (next as any).chatOverlayHoverable

        const chatWindow = deps.getChatWindow()
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
        }
      }
      if (typeof (next as any).chatOverlayMinimal === 'boolean') {
        prefs.chatOverlayMinimal = (next as any).chatOverlayMinimal

        const chatWindow = deps.getChatWindow()
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
        }
      }
      if (typeof (next as any).chatOverlayTextCursor === 'boolean') {
        prefs.chatOverlayTextCursor = (next as any).chatOverlayTextCursor

        const chatWindow = deps.getChatWindow()
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
        }
      }

      if (typeof (next as any).chatTranslucence === 'number' && isFinite((next as any).chatTranslucence)) {
        prefs.chatTranslucence = Math.max(0, Math.min(100, (next as any).chatTranslucence))

        const chatWindow = deps.getChatWindow()
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateTranslucence, prefs.chatTranslucence)
        }

        const notesFloatWindow = deps.getNotesFloatWindow()
        if (notesFloatWindow && !notesFloatWindow.isDestroyed() && notesFloatWindow.webContents) {
          notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateTransparency, prefs.chatTranslucence, 20)
        }

        const mainWindow = deps.getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
        }
      }

      if (typeof (next as any).stealthMode === 'boolean') {
        prefs.stealthMode = (next as any).stealthMode
        deps.applyChatStealthMode()
      }

      if (typeof (next as any).stealthScreenCaptureBlock === 'boolean') {
        prefs.stealthScreenCaptureBlock = (next as any).stealthScreenCaptureBlock
        deps.applyChatStealthMode()
        deps.applyNotesStealthMode()
      }

      if (typeof (next as any).stealthClickThrough === 'boolean') {
        prefs.stealthClickThrough = (next as any).stealthClickThrough
        if (prefs.stealthMode) deps.applyChatStealthMode()
      }

      if (typeof (next as any).stealthDarkTheme === 'boolean') {
        prefs.stealthDarkTheme = (next as any).stealthDarkTheme

        const chatWindow = deps.getChatWindow()
        if (chatWindow && !chatWindow.isDestroyed() && chatWindow.webContents) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateStealthTheme, prefs.stealthDarkTheme)
        }

        const notesFloatWindow = deps.getNotesFloatWindow()
        if (notesFloatWindow && !notesFloatWindow.isDestroyed() && notesFloatWindow.webContents) {
          notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateStealthMode, prefs.stealthMode ?? false, prefs.stealthDarkTheme)
        }
      }

      if (typeof (next as any).aiStyleMode === 'string') {
        const validModes = ['professional', 'casual', 'concise', 'custom']
        if (validModes.includes((next as any).aiStyleMode)) {
          prefs.aiStyleMode = (next as any).aiStyleMode
        }
      }
      if (typeof (next as any).aiStyleCustom === 'string') {
        prefs.aiStyleCustom = (next as any).aiStyleCustom
      }
      if (Array.isArray((next as any).shortcuts)) {
        prefs.shortcuts = (next as any).shortcuts
      }
      if (Array.isArray((next as any).dictionary)) {
        prefs.dictionary = (next as any).dictionary
      }
      if (Array.isArray((next as any).meetingTemplates)) {
        prefs.meetingTemplates = (next as any).meetingTemplates
      }

      if (typeof (next as any).openAtStartup === 'boolean') {
        prefs.openAtStartup = (next as any).openAtStartup
        try {
          applyLoginItemSettings(prefs.openAtStartup)
        } catch (err) {
          console.error('Failed to update auto-launch setting:', err)
        }
      }

      deps.savePrefs()
      return { ok: true, prefs }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.prefsGet, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ prefs: null })
    }
    try {
      return { ok: true, prefs: deps.getPrefs() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.prefsTestTones, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      await deps.playCueTest()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.meetingAppsGetDefaults, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ apps: {}, categories: [] as string[] })
    }
    try {
      return { ok: true, apps: DEFAULT_MEETING_APPS, categories: getMeetingAppCategories() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.meetingAppsGetCustom, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ customApps: [] as string[] })
    }
    try {
      const prefs = deps.getPrefs()
      const ignoredApps = ensureIgnoredMicApps(prefs)
      return { ok: true, ignoredApps, customApps: ignoredApps }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.meetingAppsAddCustom, async (evt, appName: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      if (!appName || typeof appName !== 'string') {
        return { ok: false, message: 'Invalid app name' }
      }

      const prefs = deps.getPrefs()
      const trimmed = appName.trim().toLowerCase()
      if (!trimmed) {
        return { ok: false, message: 'App name cannot be empty' }
      }

      const ignoredApps = ensureIgnoredMicApps(prefs)
      if (ignoredApps.includes(trimmed)) {
        return { ok: false, message: 'App already in list' }
      }

      ignoredApps.push(trimmed)
      deps.savePrefs()
      deps.updateMicWatcherIgnoredApps(ignoredApps)
      deps.sendProgress(`Added ignored mic app: ${trimmed}`)
      return { ok: true, ignoredApps, customApps: ignoredApps }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.meetingAppsRemoveCustom, async (evt, appName: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const prefs = deps.getPrefs()
      const ignoredApps = ensureIgnoredMicApps(prefs)
      if (!ignoredApps || !appName) {
        return { ok: false, message: 'Invalid app name' }
      }

      const trimmed = appName.trim().toLowerCase()
      const index = ignoredApps.indexOf(trimmed)
      if (index === -1) {
        return { ok: false, message: 'App not found in custom list' }
      }

      ignoredApps.splice(index, 1)
      deps.savePrefs()
      deps.updateMicWatcherIgnoredApps(ignoredApps)
      deps.sendProgress(`Removed ignored mic app: ${trimmed}`)
      return { ok: true, ignoredApps, customApps: ignoredApps }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsGet, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ shortcuts: null })
    }
    try {
      return { ok: true, shortcuts: keyboardShortcuts.getConfig() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsUpdate, async (evt, updates: Record<string, string>) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.sendProgress('Updating keyboard shortcuts...')
      const conflict = keyboardShortcuts.findConflict(updates)
      if (conflict) {
        return { ok: false, message: `Already used by ${describeShortcutAction(conflict.conflictsWith)}` }
      }
      const previousConfig = keyboardShortcuts.getConfig()
      const result = keyboardShortcuts.updateConfig(updates)
      if (!result) {
        return { ok: false, message: 'Failed to update shortcuts configuration' }
      }
      const refused = keyboardShortcuts.getFailedActions().filter(action => action in updates)
      if (refused.length > 0) {
        // The OS refused the new combo (another app owns it); keep the previous binding working.
        const restore: Record<string, string> = {}
        for (const action of refused) restore[action] = (previousConfig as any)[action]
        keyboardShortcuts.updateConfig(restore)
        return { ok: false, message: 'That key combination is already in use by another app' }
      }

      const currentConfig = keyboardShortcuts.getConfig()
      holdShortcuts.setShortcuts({
        dictationHold: currentConfig.dictationHold,
        aiModeHold: currentConfig.aiModeHold
      })
      holdShortcuts.setDisabledActions(deps.getPrefs().disabledShortcuts || [])

      const prefs = deps.getPrefs()
      prefs.shortcuts = currentConfig
      deps.savePrefs()

      deps.sendProgress('✓ Keyboard shortcuts updated and re-registered')
      return { ok: true, shortcuts: currentConfig }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsReset, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.sendProgress('Resetting keyboard shortcuts to default...')
      const result = keyboardShortcuts.resetToDefaults()
      if (!result) {
        return { ok: false, message: 'Failed to reset shortcuts' }
      }

      const currentConfig = keyboardShortcuts.getConfig()
      holdShortcuts.setShortcuts({
        dictationHold: currentConfig.dictationHold,
        aiModeHold: currentConfig.aiModeHold
      })
      holdShortcuts.setDisabledActions(deps.getPrefs().disabledShortcuts || [])

      const prefs = deps.getPrefs()
      prefs.shortcuts = currentConfig
      deps.savePrefs()

      deps.sendProgress('✓ Keyboard shortcuts reset to default')
      return { ok: true, shortcuts: currentConfig }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsSetHoldEnabled, async (evt, enabled: boolean) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      holdShortcuts.setPaused(!enabled)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsToggle, async (evt, actionName: string, enabled: boolean) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const prefs = deps.getPrefs()
      const disabledSet = new Set(prefs.disabledShortcuts || [])
      if (enabled) disabledSet.delete(actionName)
      else disabledSet.add(actionName)

      prefs.disabledShortcuts = Array.from(disabledSet)
      deps.savePrefs()

      keyboardShortcuts.setDisabledActions(prefs.disabledShortcuts)
      if (actionName === 'dictationHold' || actionName === 'aiModeHold') {
        holdShortcuts.setDisabledActions(prefs.disabledShortcuts)
      }

      return { ok: true, enabled }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.shortcutsGetDisabled, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ disabled: [] as string[] })
    }
    return { ok: true, disabled: deps.getPrefs().disabledShortcuts || [] }
  })

  ipcMain.handle(IPC.invoke.settings.stealthToggle, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ enabled: false })
    }
    try {
      const prefs = deps.getPrefs()
      prefs.stealthMode = !prefs.stealthMode
      deps.applyChatStealthMode()

      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
      }

      deps.savePrefs()
      return { ok: true, enabled: prefs.stealthMode }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.stealthToggleClickThrough, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ enabled: false })
    }
    try {
      deps.toggleChatClickThrough()
      return { ok: true, enabled: deps.getPrefs().stealthClickThrough }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.settings.logsShare, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const p = getLogFilePath()
      const text = p && fs.existsSync(p) ? await fsp.readFile(p, 'utf8') : ''
      const res = await dialog.showSaveDialog({
        title: 'Save logs',
        defaultPath: 'notto.log',
        filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
      })
      if (res.canceled || !res.filePath) return { ok: false, message: 'Save canceled' }
      await fsp.writeFile(res.filePath, text, 'utf8')
      return { ok: true, path: res.filePath }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
