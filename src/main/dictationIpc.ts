import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { IPC } from '../shared/ipcChannels'
import { didFocusTargetChange, shouldRestoreClipboardText } from './securityUtils'
import { sendWindowsPasteShortcut } from './windowsPaste'

type DictationOrigin = 'global' | 'chat'

interface DictationIpcDependencies {
  getPrefs: () => any
  savePrefs: () => void
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
  getMainWindow: () => BrowserWindow | null
  getChatWindow: () => BrowserWindow | null
  closePromptWindow: () => void
  ensureNotesFloatWindowVisible: () => void
  getHudWindow: () => BrowserWindow | null
  hideHudWindow: () => void
  getHudCloseTimeout: () => NodeJS.Timeout | null
  setHudCloseTimeout: (timer: NodeJS.Timeout | null) => void
  getDictationOrigin: () => DictationOrigin
  setDictationOrigin: (value: DictationOrigin) => void
  getDictationActive: () => boolean
  setDictationActive: (value: boolean) => void
  setAiModeActive: (value: boolean) => void
  setHandsFreeActive: (value: boolean) => void
  setKeepHudUntilPaste: (value: boolean) => void
  setChatInitiatedDictation: (value: boolean) => void
  setMicSuppressUntilInactive: (value: boolean) => void
  setCurrentMicSessionDismissed: (value: boolean) => void
  toggleDictation: (origin?: DictationOrigin) => void
}

export function registerDictationIpcHandlers(deps: DictationIpcDependencies): void {
  const hideHud = () => {
    deps.setKeepHudUntilPaste(false)
    deps.setHandsFreeActive(false)

    const timeout = deps.getHudCloseTimeout()
    if (timeout) {
      clearTimeout(timeout)
      deps.setHudCloseTimeout(null)
    }

    deps.hideHudWindow()
  }

  ipcMain.handle(IPC.invoke.chat.dictationToggle, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ active: deps.getDictationActive() })
    }

    try {
      deps.toggleDictation('chat')
      return { ok: true, active: deps.getDictationActive() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.ui.promptStart, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    deps.setMicSuppressUntilInactive(true)
    try {
      deps.getMainWindow()?.webContents.send(IPC.event.mainToRenderer.uiRecord)
    } catch { }
    deps.closePromptWindow()
    deps.ensureNotesFloatWindowVisible()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.ui.promptDismiss, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    deps.setCurrentMicSessionDismissed(true)
    deps.setMicSuppressUntilInactive(true)
    deps.closePromptWindow()
    deps.sendProgress('Prompt dismissed for this mic session')
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.ui.dictationPaste, async (evt, text: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ skipped: false, chatOnly: false, pasteCompleted: false, focusChanged: false })
    }

    try {
      const trimmedText = (text ?? '').trim()
      const chatWindow = deps.getChatWindow()
      const chatFocused = !!chatWindow && BrowserWindow.getFocusedWindow() === chatWindow
      const wasChatInitiated = deps.getDictationOrigin() === 'chat' && chatFocused

      deps.setChatInitiatedDictation(false)
      deps.setDictationOrigin('global')

      const completionText = wasChatInitiated ? trimmedText : ''
      try {
        chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, completionText)
      } catch { }

      deps.sendProgress(`[Main] dictation:paste called. Text len: ${trimmedText.length}. ChatInitiated: ${wasChatInitiated}`)

      if (!trimmedText) {
        hideHud()
        deps.sendProgress('Dictation: No text transcribed, skipping paste')
        return { ok: true, skipped: true, focusChanged: false }
      }

      if (wasChatInitiated) {
        hideHud()
        deps.sendProgress(`Chat dictation: ${trimmedText.length} chars sent to chat input`)
        return { ok: true, chatOnly: true, focusChanged: false }
      }

      const previousClipboardText = clipboard.readText()
      const focusBeforePaste = BrowserWindow.getFocusedWindow()?.id ? String(BrowserWindow.getFocusedWindow()?.id) : null
      clipboard.writeText(trimmedText)

      let pasteCompleted = false

      let clipboardRestoreDelayMs = 150
      if (process.platform === 'win32') {
        // Give the target app time to process the injected keys before the clipboard changes back.
        clipboardRestoreDelayMs = 400
        await new Promise((resolve) => setTimeout(resolve, 60))
        pasteCompleted = sendWindowsPasteShortcut()
        if (!pasteCompleted) {
          // PowerShell can take seconds to start; wait for it to exit before restoring the clipboard.
          await new Promise<void>((resolve) => {
            const ps = spawn('powershell.exe', [
              '-NoProfile',
              '-Command',
              "$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 60; $wshell.SendKeys('^v')"
            ], { stdio: ['ignore', 'ignore', 'ignore'] })
            ps.on('error', () => resolve())
            ps.on('close', (code) => {
              pasteCompleted = code === 0
              resolve()
            })
            setTimeout(resolve, 6000)
          })
        }
      } else if (process.platform === 'darwin') {
        await new Promise<void>((resolve) => {
          const osa = spawn('osascript', ['-e', 'delay 0.12', '-e', 'tell application "System Events" to keystroke "v" using command down'], { stdio: ['ignore', 'ignore', 'ignore'] })
          osa.on('error', () => {
            deps.getPrefs().automationApproved = false
            deps.savePrefs()
            resolve()
          })
          osa.on('close', (code) => {
            if (code !== 0) {
              deps.getPrefs().automationApproved = false
              deps.savePrefs()
            } else {
              pasteCompleted = true
            }
            resolve()
          })
          setTimeout(resolve, 800)
        })
      } else {
        await new Promise<void>((resolve) => {
          const xdotool = spawn('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { stdio: ['ignore', 'ignore', 'ignore'] })
          // Missing xdotool or a Wayland session: the paste fails and the text stays on the clipboard.
          xdotool.on('error', () => resolve())
          xdotool.on('close', (code) => {
            pasteCompleted = code === 0
            resolve()
          })
          setTimeout(resolve, 2000)
        })
      }

      if (pasteCompleted) {
        setTimeout(() => {
          try {
            if (shouldRestoreClipboardText(clipboard.readText(), trimmedText)) {
              clipboard.writeText(previousClipboardText)
            }
          } catch { }
        }, clipboardRestoreDelayMs)
      } else {
        // Keep the dictation on the clipboard so it is not lost; the user can paste it manually.
        deps.sendProgress('Could not paste automatically; the dictated text is on the clipboard')
      }

      const focusAfterPaste = BrowserWindow.getFocusedWindow()?.id ? String(BrowserWindow.getFocusedWindow()?.id) : null
      const focusChanged = didFocusTargetChange(focusBeforePaste, focusAfterPaste)
      if (focusChanged) {
        deps.sendProgress('Dictation paste target changed before paste completed')
      }

      hideHud()
      deps.sendProgress(`Dictation paste: ${trimmedText.length} chars`)
      return { ok: true, pasteCompleted, focusChanged }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.ui.dictationCloseHud, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    try {
      hideHud()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.ui.hudUpdate, async (evt, update: { vis?: boolean; audio?: boolean; kind?: string; mode?: string; vol?: number; text?: string; audioLevels?: number[] }) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    try {
      deps.getHudWindow()?.webContents.send(IPC.event.mainToRenderer.hudUpdate, update)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.on(IPC.send.rendererToMain.hudUpdateFast, (evt, update: { audioLevels?: number[] }) => {
    if (!deps.isTrustedRendererEvent(evt)) return
    try {
      deps.getHudWindow()?.webContents.send(IPC.event.mainToRenderer.hudUpdate, update)
    } catch { }
  })

  ipcMain.handle(IPC.invoke.ui.dictationMicError, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    deps.setDictationActive(false)
    deps.setHandsFreeActive(false)
    deps.setKeepHudUntilPaste(false)
    deps.setChatInitiatedDictation(false)
    deps.setDictationOrigin('global')
    deps.setMicSuppressUntilInactive(false)
    deps.setCurrentMicSessionDismissed(false)
    try {
      deps.getChatWindow()?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '')
    } catch { }
    try {
      deps.getMainWindow()?.webContents.send(IPC.event.mainToRenderer.dictationStop)
    } catch { }
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.ui.aimodeMicError, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    deps.setAiModeActive(false)
    deps.setHandsFreeActive(false)
    deps.setKeepHudUntilPaste(false)
    deps.setChatInitiatedDictation(false)
    deps.setDictationOrigin('global')
    deps.setMicSuppressUntilInactive(false)
    deps.setCurrentMicSessionDismissed(false)
    try {
      deps.getMainWindow()?.webContents.send(IPC.event.mainToRenderer.aimodeStop)
    } catch { }
    try {
      deps.getChatWindow()?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '')
    } catch { }
    return { ok: true }
  })
}
