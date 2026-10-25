import { BrowserWindow, Notification, ipcMain } from 'electron'
import { IPC } from '../shared/ipcChannels'
import { NotesRepository, type CreateNoteParams } from './notesRepository'

interface NotesIpcDependencies {
  repo: NotesRepository
  getPrefs: () => any
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
  isNotesIpcAllowed: (evt: Electron.IpcMainInvokeEvent) => boolean
  getMainWindow: () => BrowserWindow | null
  getNotesFloatWindow: () => BrowserWindow | null
  getHudWindow: () => BrowserWindow | null
  ensureNotesFloatWindowVisible: () => void
  hideNotesOverlayWindow: () => void
  getIsMeetingActive: () => boolean
  setIsMeetingActive: (value: boolean) => void
  getIsRecordingPaused: () => boolean
  setIsRecordingPaused: (value: boolean) => void
  getSilenceDetectionTimer: () => NodeJS.Timeout | null
  setSilenceDetectionTimer: (timer: NodeJS.Timeout | null) => void
  getLastAudioActivity: () => number
  setLastAudioActivity: (value: number) => void
  getPersonalNotesContent: () => string
  setPersonalNotesContent: (value: string) => void
  getStandaloneNoteId: () => string | null
  setStandaloneNoteId: (value: string | null) => void
  setLastTranscriptText: (value: string) => void
  setLastSummaryText: (value: string) => void
}

export function registerNotesIpcHandlers(deps: NotesIpcDependencies): void {
  let standaloneSyncChain: Promise<void> = Promise.resolve()
  const armSilenceDetectionTimer = () => {
    const existingTimer = deps.getSilenceDetectionTimer()
    if (existingTimer) clearInterval(existingTimer)

    deps.setSilenceDetectionTimer(setInterval(() => {
      if (
        deps.getIsMeetingActive() &&
        !deps.getIsRecordingPaused() &&
        Date.now() - deps.getLastAudioActivity() > 10000
      ) {
        deps.sendProgress('No audio activity for 10s - auto-stopping recording...')
        const mainWindow = deps.getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(IPC.event.mainToRenderer.meetingAutoStop)
        }
        const timer = deps.getSilenceDetectionTimer()
        if (timer) clearInterval(timer)
        deps.setSilenceDetectionTimer(null)
      }
    }, 2000))
  }

  ipcMain.handle(IPC.invoke.notes.list, async (evt) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }
      return { ok: true, items: await deps.repo.list() }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.read, async (evt, id: string) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }
      return { ok: true, text: await deps.repo.read(id) }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.save, async (evt, id: string, text: string) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }
      await deps.repo.save(id, text ?? '')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.delete, async (evt, id: string) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }
      await deps.repo.delete(id)
      deps.sendProgress(`Successfully deleted note: ${id}`)
      return { ok: true }
    } catch (e: any) {
      deps.sendProgress(`Delete error for ${id}: ${e?.message ?? String(e)}`)
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.rename, async (evt, id: string, nextId: string) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }
      await deps.repo.rename(id, nextId)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.create, async (evt, params: CreateNoteParams) => {
    try {
      if (!deps.isNotesIpcAllowed(evt)) return { ok: false, message: 'Not permitted' }

      const created = await deps.repo.create(params)
      if (params.transcript) deps.setLastTranscriptText(params.transcript)
      if (params.summary) deps.setLastSummaryText(params.summary)

      if ((params.transcript || params.summary) && deps.getPrefs().meetingNotificationsEnabled !== false) {
        new Notification({
          title: 'Meeting Note Ready!',
          body: `Note "${params.title || 'Untitled'}" has been processed and saved.`,
          silent: false
        }).show()
      }

      return { ok: true, id: created.id }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.openWindow, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.setStandaloneNoteId(null)

      deps.ensureNotesFloatWindowVisible()
      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingStatusUpdate, false)
      }

      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.closeWindow, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.setIsMeetingActive(false)
      deps.setIsRecordingPaused(false)
      const timer = deps.getSilenceDetectionTimer()
      if (timer) clearInterval(timer)
      deps.setSilenceDetectionTimer(null)

      deps.setPersonalNotesContent('')
      deps.setStandaloneNoteId(null)

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingStatusUpdate, false)
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, '')
      }

      deps.hideNotesOverlayWindow()

      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, '')
      }

      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.hideWindow, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      const timer = deps.getSilenceDetectionTimer()
      if (timer) clearInterval(timer)
      deps.setSilenceDetectionTimer(null)

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingStatusUpdate, false)
      }

      deps.hideNotesOverlayWindow()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.meetingUpdateAudioActivity, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    deps.setLastAudioActivity(Date.now())
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.notes.meetingCaptureStarted, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    try {
      deps.setIsMeetingActive(true)
      deps.setIsRecordingPaused(false)
      deps.setLastAudioActivity(Date.now())
      deps.setStandaloneNoteId(null)
      armSilenceDetectionTimer()

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingStatusUpdate, true)
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingPaused, false)
      }

      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.meetingPause, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.setIsRecordingPaused(true)
      deps.setLastAudioActivity(Date.now())
      deps.sendProgress('Recording paused')

      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.recordingPaused)
      }

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingPaused, true)
      }

      const hudWindow = deps.getHudWindow()
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: false, kind: 'pause', mode: 'meeting' })
      }

      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.meetingResume, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.setIsRecordingPaused(false)
      deps.setLastAudioActivity(Date.now())
      armSilenceDetectionTimer()
      deps.sendProgress('Recording resumed')

      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.recordingResumed)
      }

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingPaused, false)
      }

      const hudWindow = deps.getHudWindow()
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: false, kind: 'resume', mode: 'meeting' })
      }

      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.stopRecording, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.sendProgress('Stopping recording from notes window...')
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.meetingAutoStop)
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.meetingStopFromHud, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.sendProgress('Stopping recording from meeting HUD...')
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.meetingAutoStop)
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.updateContent, async (evt, content: string) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    deps.setPersonalNotesContent(content)
    const senderId = evt.sender?.id

    const mainWindow = deps.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id !== senderId) {
      mainWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, content)
    }

    const notesFloatWindow = deps.getNotesFloatWindow()
    if (notesFloatWindow && !notesFloatWindow.isDestroyed() && notesFloatWindow.webContents.id !== senderId) {
      notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, content)
    }

    if (!deps.getIsMeetingActive()) {
      // Serialize read-id → sync → store-id; overlapping updates would otherwise each create a quick note.
      const sync = standaloneSyncChain.then(async () => {
        const nextStandaloneId = await deps.repo.syncStandaloneNote(deps.getStandaloneNoteId(), content)
        deps.setStandaloneNoteId(nextStandaloneId)
      })
      standaloneSyncChain = sync.catch(() => { })
      try {
        await sync
      } catch (e: any) {
        deps.sendProgress(`Quick note sync failed: ${e?.message ?? String(e)}`)
      }
    }

    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.notes.getContent, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ content: '' })
    }
    return { ok: true, content: deps.getPersonalNotesContent() }
  })

  ipcMain.handle(IPC.invoke.notes.newNote, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.setStandaloneNoteId(null)
      deps.setPersonalNotesContent('')

      const notesFloatWindow = deps.getNotesFloatWindow()
      if (notesFloatWindow && !notesFloatWindow.isDestroyed() && notesFloatWindow.webContents) {
        notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, '')
      }
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.notesContentUpdated, '')
      }

      deps.sendProgress('Ready for new quick note')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.meetingStartFromNotes, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }
    try {
      deps.sendProgress('Starting meeting recording from notes window...')
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send(IPC.event.mainToRenderer.meetingStartRecording)
      }
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle(IPC.invoke.notes.requestSettings, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult()
    }

    const prefs = deps.getPrefs()
    const opacity = prefs.chatTranslucence ?? 50
    const blur = prefs.chatBlur ?? 20
    const stealthEnabled = prefs.stealthMode ?? false
    const darkTheme = prefs.stealthDarkTheme ?? false

    const notesFloatWindow = deps.getNotesFloatWindow()
    if (notesFloatWindow && !notesFloatWindow.isDestroyed() && notesFloatWindow.webContents) {
      notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateTransparency, opacity, blur)
      notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateStealthMode, stealthEnabled, darkTheme)
      notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesRecordingStatusUpdate, deps.getIsMeetingActive())
    }

    return { ok: true }
  })
}
