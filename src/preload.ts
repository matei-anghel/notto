import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from './shared/ipcChannels'
import type { ChatAttachment } from './shared/chatAttachments'
import type { OnboardingWizardState, PermissionGroupId } from './shared/permissions'
import type { AiSettings, AiSettingsSnapshot } from './shared/aiProviders'

type Mode = 'mic' | 'system' | 'both'

contextBridge.exposeInMainWorld('electronAPI', {
  // Batch WAV recording (native)
  wavrecStart: () => ipcRenderer.invoke(IPC.invoke.audio.wavrecStart),
  wavrecChunkPCM16: (pcm: ArrayBuffer) => ipcRenderer.invoke(IPC.invoke.audio.wavrecChunk, pcm),
  wavrecStop: () => ipcRenderer.invoke(IPC.invoke.audio.wavrecStop),
  // WebM streaming recording (MediaRecorder)
  webmrecStart: () => ipcRenderer.invoke(IPC.invoke.audio.webmrecStart),
  webmrecChunk: (chunk: ArrayBuffer) => ipcRenderer.send(IPC.send.rendererToMain.webmrecChunk, chunk),
  webmrecStop: () => ipcRenderer.invoke(IPC.invoke.audio.webmrecStop),
  // OpenRouter API for cloud STT and summarization
  apiTranscribe: (recordingId: string, opts?: { deleteInput?: boolean; isAIMode?: boolean; isMeetingMode?: boolean }) => ipcRenderer.invoke(IPC.invoke.audio.transcribeRecording, { recordingId, ...(opts || {}) }),
  apiTranscribeBuffer: (wavBuffer: ArrayBuffer, opts?: { isAIMode?: boolean; isMeetingMode?: boolean }) => ipcRenderer.invoke(IPC.invoke.audio.transcribeBuffer, { wavBuffer, ...(opts || {}) }),
  // Deepgram Nova-3 dictation (faster, with Groq fallback)
  deepgramTranscribeDictation: (wavBuffer: ArrayBuffer) => ipcRenderer.invoke(IPC.invoke.audio.deepgramTranscribeDictation, { wavBuffer }),
  // Deepgram Direct WebSocket streaming (fastest - no Firebase audio hop)
  deepgramGetToken: () => ipcRenderer.invoke(IPC.invoke.audio.deepgramGetToken),
  deepgramStartStream: (token: string) => ipcRenderer.invoke(IPC.invoke.audio.deepgramStartStream, { token }),
  deepgramSendChunk: (chunk: ArrayBuffer) => ipcRenderer.invoke(IPC.invoke.audio.deepgramSendChunk, { chunk }),
  deepgramStopStream: () => ipcRenderer.invoke(IPC.invoke.audio.deepgramStopStream),
  onDeepgramTranscript: (handler: (data: { interim: string; final: string; isFinal: boolean }) => void) => {
    const wrapped = (_evt: any, data: any) => handler(data)
    ipcRenderer.on(IPC.event.mainToRenderer.deepgramTranscript, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.deepgramTranscript, wrapped)
  },

  apiSummarize: (transcript: string, notes?: string) => ipcRenderer.invoke(IPC.invoke.audio.summarizeMeeting, { transcript, notes }),
  promptStart: () => ipcRenderer.invoke(IPC.invoke.ui.promptStart),
  promptDismiss: (ms: number) => ipcRenderer.invoke(IPC.invoke.ui.promptDismiss, ms),
  zoomGet: () => ipcRenderer.invoke(IPC.invoke.control.zoomGet),
  zoomSet: (factor: number) => ipcRenderer.invoke(IPC.invoke.control.zoomSet, factor),
  zoomDelta: (delta: number) => ipcRenderer.invoke(IPC.invoke.control.zoomDelta, delta)
  , prefsUpdate: (p: Partial<{ cueVisual: boolean; cueAudio: boolean; cueVolume: number; keepRecordings: boolean; meetingAware: boolean; chatTranslucence: number; aiDictationModel: string; stealthMode: boolean; stealthScreenCaptureBlock: boolean; stealthClickThrough: boolean; stealthDarkTheme: boolean; chatOverlayHoverable: boolean; chatOverlayMinimal: boolean; chatOverlayTextCursor: boolean; openAtStartup: boolean; dictationLanguage: string }>) => ipcRenderer.invoke(IPC.invoke.settings.prefsUpdate, p)
  , prefsGet: () => ipcRenderer.invoke(IPC.invoke.settings.prefsGet)
  , onPrefsUpdate: (handler: (prefs: any) => void) => {
    const wrapped = (_evt: any, prefs: any) => handler(prefs)
    ipcRenderer.on(IPC.event.mainToRenderer.prefsUpdate, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.prefsUpdate, wrapped)
  }
  , prefsTestTones: () => ipcRenderer.invoke(IPC.invoke.settings.prefsTestTones)
  , logsShare: () => ipcRenderer.invoke(IPC.invoke.settings.logsShare)
  // Keyboard shortcuts
  , shortcutsGet: () => ipcRenderer.invoke(IPC.invoke.settings.shortcutsGet)
  , shortcutsUpdate: (updates: Record<string, string>) => ipcRenderer.invoke(IPC.invoke.settings.shortcutsUpdate, updates)
  , shortcutsReset: () => ipcRenderer.invoke(IPC.invoke.settings.shortcutsReset)
  , shortcutsToggle: (actionName: string, enabled: boolean) => ipcRenderer.invoke(IPC.invoke.settings.shortcutsToggle, actionName, enabled)
  , shortcutsGetDisabled: () => ipcRenderer.invoke(IPC.invoke.settings.shortcutsGetDisabled)
  , setHoldShortcutsEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.invoke.settings.shortcutsSetHoldEnabled, enabled)
  // Mic-app ignore list management
  , meetingAppsGetDefaults: () => ipcRenderer.invoke(IPC.invoke.settings.meetingAppsGetDefaults)
  , meetingAppsGetCustom: () => ipcRenderer.invoke(IPC.invoke.settings.meetingAppsGetCustom)
  , meetingAppsAddCustom: (appName: string) => ipcRenderer.invoke(IPC.invoke.settings.meetingAppsAddCustom, appName)
  , meetingAppsRemoveCustom: (appName: string) => ipcRenderer.invoke(IPC.invoke.settings.meetingAppsRemoveCustom, appName)
  , notesList: () => ipcRenderer.invoke(IPC.invoke.notes.list)
  , notesRead: (id: string) => ipcRenderer.invoke(IPC.invoke.notes.read, id)
  , notesSave: (id: string, text: string) => ipcRenderer.invoke(IPC.invoke.notes.save, id, text)
  , notesDelete: (id: string) => ipcRenderer.invoke(IPC.invoke.notes.delete, id)
  , notesRename: (id: string, nextId: string) => ipcRenderer.invoke(IPC.invoke.notes.rename, id, nextId)
  , notesCreate: (params: { title?: string; summary?: string; transcript?: string; notes?: string }) => ipcRenderer.invoke(IPC.invoke.notes.create, params)
  , exportSaveAs: (args: { suggestedName?: string; text: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke(IPC.invoke.data.exportSaveAs, args)
  // Stats & Activity - file-based persistence
  , statsGet: () => ipcRenderer.invoke(IPC.invoke.data.statsGet)
  , statsUpdate: (update: { wordsDictated?: number; dictationTimeSeconds?: number; meetingsTranscripted?: number }) => ipcRenderer.invoke(IPC.invoke.data.statsUpdate, update)
  , statsReset: () => ipcRenderer.invoke(IPC.invoke.data.statsReset)
  , onStatsUpdate: (handler: (stats: any) => void) => {
    const wrapped = (_evt: any, stats: any) => handler(stats)
    ipcRenderer.on(IPC.event.mainToRenderer.statsUpdated, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.statsUpdated, wrapped)
  }
  , activityGet: () => ipcRenderer.invoke(IPC.invoke.data.activityGet)
  , activityAdd: (log: { text: string; icon: string; type?: string; fullText?: string; durationSeconds?: number }) => ipcRenderer.invoke(IPC.invoke.data.activityAdd, log)
  , activityDelete: (timestamp: number) => ipcRenderer.invoke(IPC.invoke.data.activityDelete, timestamp)
  , onActivityUpdate: (handler: (logs: any[]) => void) => {
    const wrapped = (_evt: any, logs: any[]) => handler(logs)
    ipcRenderer.on(IPC.event.mainToRenderer.activityUpdated, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.activityUpdated, wrapped)
  }
  , trainerGetOverview: () => ipcRenderer.invoke(IPC.invoke.trainer.getOverview)
  , trainerAnalyzeNote: (noteId: string) => ipcRenderer.invoke(IPC.invoke.trainer.analyzeNote, noteId)
  // AI Chat APIs
  , chatSend: (params: { messages: any[]; stream?: boolean; manualNoteIds?: string[]; searchAllNotes?: boolean }) => ipcRenderer.invoke(IPC.invoke.chat.send, params)
  , chatOpenFilePicker: () => ipcRenderer.invoke(IPC.invoke.chat.openFilePicker)
  , chatPrepareAttachments: (filePaths: string[]) => ipcRenderer.invoke(IPC.invoke.chat.prepareAttachments, { filePaths })
  , chatMinimize: () => ipcRenderer.invoke(IPC.invoke.chat.minimize)
  , chatClose: () => ipcRenderer.invoke(IPC.invoke.chat.close)
  , chatToggle: () => ipcRenderer.invoke(IPC.invoke.chat.toggle)
  , chatResize: (height: number) => ipcRenderer.invoke(IPC.invoke.chat.resize, height)
  , chatAbort: () => ipcRenderer.invoke(IPC.invoke.chat.abort)
  , chatDictationToggle: () => ipcRenderer.invoke(IPC.invoke.chat.dictationToggle)
  , clipboardRead: () => ipcRenderer.invoke(IPC.invoke.chat.clipboardRead).then((r: any) => r.text || '')
  , getLastTranscript: () => ipcRenderer.invoke(IPC.invoke.chat.getLastTranscript).then((r: any) => r.text || '')

  // HUD update handler
  , onHudUpdate: (handler: (update: { vis?: boolean; audio?: boolean; kind?: string; mode?: string; vol?: number; audioLevels?: number[] }) => void) => {
    const wrapped = (_evt: any, update: any) => handler(update)
    ipcRenderer.on(IPC.event.mainToRenderer.hudUpdate, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.hudUpdate, wrapped)
  }
  // NOTE: hudUpdate uses invoke (request/response). Prefer hudUpdateFast for high-rate updates like audioLevels.
  , hudUpdate: (update: { vis?: boolean; audio?: boolean; kind?: string; mode?: string; vol?: number; text?: string; audioLevels?: number[] }) => ipcRenderer.invoke(IPC.invoke.ui.hudUpdate, update)
  , hudUpdateFast: (update: { audioLevels?: number[] }) => ipcRenderer.send(IPC.send.rendererToMain.hudUpdateFast, update)
  // Close HUD
  , dictationCloseHUD: () => ipcRenderer.invoke(IPC.invoke.ui.dictationCloseHud)
  // Stealth mode
  , stealthToggle: () => ipcRenderer.invoke(IPC.invoke.settings.stealthToggle)
  , stealthToggleClickThrough: () => ipcRenderer.invoke(IPC.invoke.settings.stealthToggleClickThrough)
  // Tray controls
  , trayUpdateRecordingState: (recording: boolean) => ipcRenderer.invoke(IPC.invoke.control.trayUpdateRecordingState, recording)
  , trayUpdateAudioMode: (mode: 'mic' | 'system' | 'both') => ipcRenderer.invoke(IPC.invoke.control.trayUpdateAudioMode, mode)
  // Utility
  , openExternal: (url: string) => ipcRenderer.invoke(IPC.invoke.control.openExternal, url)
  , debugLog: (message: string) => ipcRenderer.invoke(IPC.invoke.control.log, message)
  , dictationMicError: () => ipcRenderer.invoke(IPC.invoke.ui.dictationMicError)
  , aimodeMicError: () => ipcRenderer.invoke(IPC.invoke.ui.aimodeMicError)
  , deleteTempRecording: (recordingId: string) => ipcRenderer.invoke(IPC.invoke.control.fileDelete, recordingId)
  , meetingPause: () => ipcRenderer.invoke(IPC.invoke.notes.meetingPause)
  , meetingResume: () => ipcRenderer.invoke(IPC.invoke.notes.meetingResume)
  , meetingStopFromHUD: () => ipcRenderer.invoke(IPC.invoke.notes.meetingStopFromHud)
  , meetingUpdateAudioActivity: () => ipcRenderer.invoke(IPC.invoke.notes.meetingUpdateAudioActivity)
  , meetingCaptureStarted: () => ipcRenderer.invoke(IPC.invoke.notes.meetingCaptureStarted)
  , screenshotCapture: () => ipcRenderer.invoke(IPC.invoke.screenshot.capture)
  , screenshotGetBase64: (id: string) => ipcRenderer.invoke(IPC.invoke.screenshot.getBase64, id)
  , notesOpenWindow: () => ipcRenderer.invoke(IPC.invoke.notes.openWindow)
  , notesHideWindow: () => ipcRenderer.invoke(IPC.invoke.notes.hideWindow)
  , notesCloseWindow: () => ipcRenderer.invoke(IPC.invoke.notes.closeWindow)
  // Database
  , saveChat: (id: string, title: string, messages: any[]) => ipcRenderer.invoke(IPC.invoke.data.dbSaveChat, { id, title, messages })
  , getHistory: (limit: number = 50, offset: number = 0) => ipcRenderer.invoke(IPC.invoke.data.dbGetHistory, { limit, offset })
  , getChat: (id: string) => ipcRenderer.invoke(IPC.invoke.data.dbGetChat, id)
  , deleteChat: (id: string) => ipcRenderer.invoke(IPC.invoke.data.dbDeleteChat, id)
  , searchChats: (query: string) => ipcRenderer.invoke(IPC.invoke.data.dbSearch, query)
  // AI providers: settings and keys (keys are write-only from the renderer)
  , ai: {
    getSettings: () => ipcRenderer.invoke(IPC.invoke.ai.getSettings),
    setSettings: (settings: unknown) => ipcRenderer.invoke(IPC.invoke.ai.setSettings, settings),
    setKey: (providerId: string, key: string) => ipcRenderer.invoke(IPC.invoke.ai.setKey, providerId, key),
    listModels: (providerId: string) => ipcRenderer.invoke(IPC.invoke.ai.listModels, providerId)
  }
  // macOS Permissions API
  , permissions: {
    getStatus: () => ipcRenderer.invoke(IPC.invoke.permissions.getStatus),
    getWizardState: () => ipcRenderer.invoke(IPC.invoke.permissions.getWizardState),
    checkStep: (step: PermissionGroupId) => ipcRenderer.invoke(IPC.invoke.permissions.checkStep, step),
    openStepSettings: (step: PermissionGroupId) => ipcRenderer.invoke(IPC.invoke.permissions.openStepSettings, step),
    restartAndResume: () => ipcRenderer.invoke(IPC.invoke.permissions.restartAndResume),
    resetOnboarding: () => ipcRenderer.invoke(IPC.invoke.permissions.resetOnboarding),
    getDebugInfo: () => ipcRenderer.invoke(IPC.invoke.permissions.getDebugInfo),
    probeScreenRecording: () => ipcRenderer.invoke(IPC.invoke.permissions.probeScreenRecording),
    requestMicrophone: () => ipcRenderer.invoke(IPC.invoke.permissions.requestMicrophone),
    requestAccessibility: () => ipcRenderer.invoke(IPC.invoke.permissions.requestAccessibility),
    requestAutomation: () => ipcRenderer.invoke(IPC.invoke.permissions.requestAutomation),
    requestInputMonitoring: () => ipcRenderer.invoke(IPC.invoke.permissions.requestInputMonitoring),
    openScreenRecordingPreferences: () => ipcRenderer.invoke(IPC.invoke.permissions.openScreenRecordingPreferences),
    openMicrophonePreferences: () => ipcRenderer.invoke(IPC.invoke.permissions.openMicrophonePreferences),
    openAccessibilityPreferences: () => ipcRenderer.invoke(IPC.invoke.permissions.openAccessibilityPreferences),
    openAutomationPreferences: () => ipcRenderer.invoke(IPC.invoke.permissions.openAutomationPreferences),
    openInputMonitoringPreferences: () => ipcRenderer.invoke(IPC.invoke.permissions.openInputMonitoringPreferences),
    acknowledgeSystemAudioCapturePreflight: (preflightStarted?: boolean) => ipcRenderer.invoke(IPC.invoke.permissions.acknowledgeSystemAudioCapturePreflight, preflightStarted),
    completeOnboarding: () => ipcRenderer.invoke(IPC.invoke.permissions.completeOnboarding),
    needsOnboarding: () => ipcRenderer.invoke(IPC.invoke.permissions.needsOnboarding),
    reinitializeHoldShortcuts: () => ipcRenderer.invoke(IPC.invoke.permissions.reinitializeHoldShortcuts)
  }
  // App control APIs
  , app: {
    relaunch: () => ipcRenderer.invoke(IPC.invoke.control.appRelaunch)
  }
  , onOpacityAdjust: (handler: (delta: number) => void) => {
    const wrapped = (_evt: any, delta: number) => handler(delta)
    ipcRenderer.on(IPC.event.mainToRenderer.opacityAdjust, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.opacityAdjust, wrapped)
  }
  , onChatShortcutSend: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatShortcutSend, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatShortcutSend, wrapped)
  }
  , onChatShortcutNew: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatShortcutNew, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatShortcutNew, wrapped)
  }
  , onScreenshotCaptured: (handler: (screenshot: { id: string; filePath: string; timestamp: number }) => void) => {
    const wrapped = (_evt: any, screenshot: { id: string; filePath: string; timestamp: number }) => handler(screenshot)
    ipcRenderer.on(IPC.event.mainToRenderer.screenshotCaptured, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.screenshotCaptured, wrapped)
  }
})

// Window controls
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke(IPC.invoke.control.windowMinimize),
  toggleMaximize: () => ipcRenderer.invoke(IPC.invoke.control.windowToggleMaximize),
  isMaximized: () => ipcRenderer.invoke(IPC.invoke.control.windowIsMaximized),
  close: () => ipcRenderer.invoke(IPC.invoke.control.windowClose)
})

// Progress event stream from main
contextBridge.exposeInMainWorld('progress', {
  onLog: (handler: (message: string) => void) => {
    const wrapped = (_evt: any, msg: string) => handler(msg)
    ipcRenderer.on(IPC.event.mainToRenderer.progressLog, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.progressLog, wrapped)
  }
})

// UI control events (main -> renderer)
contextBridge.exposeInMainWorld('ui', {
  onRecord: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.uiRecord, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.uiRecord, wrapped)
  },
  onAutoStop: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.meetingAutoStop, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.meetingAutoStop, wrapped)
  },
  onRecordingPaused: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.recordingPaused, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.recordingPaused, wrapped)
  },
  onRecordingResumed: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.recordingResumed, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.recordingResumed, wrapped)
  },
  onStartRecording: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.meetingStartRecording, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.meetingStartRecording, wrapped)
  },
  onTrayStartRecording: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.trayStartRecording, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.trayStartRecording, wrapped)
  },
  onTrayStopRecording: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.trayStopRecording, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.trayStopRecording, wrapped)
  },
  onTrayAudioModeChanged: (handler: (mode: 'mic' | 'system' | 'both') => void) => {
    const wrapped = (_evt: any, mode: 'mic' | 'system' | 'both') => handler(mode)
    ipcRenderer.on(IPC.event.mainToRenderer.trayAudioModeChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.trayAudioModeChanged, wrapped)
  }
})

// Dictation events and actions
contextBridge.exposeInMainWorld('dictation', {
  onStart: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.dictationStart, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.dictationStart, wrapped)
  },
  onStop: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.dictationStop, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.dictationStop, wrapped)
  },
  paste: (text: string) => ipcRenderer.invoke(IPC.invoke.ui.dictationPaste, text)
})

// Agentic Dictation events (similar to dictation but with different prompt)
contextBridge.exposeInMainWorld('aimode', {
  onStart: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.aimodeStart, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.aimodeStart, wrapped)
  },
  onStop: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.aimodeStop, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.aimodeStop, wrapped)
  },
  paste: (text: string) => ipcRenderer.invoke(IPC.invoke.ui.dictationPaste, text)
})

// App lifecycle: save pending edits before the app quits or relaunches.
contextBridge.exposeInMainWorld('lifecycle', {
  onFlushRequest: (handler: () => Promise<void> | void) => {
    const wrapped = async () => {
      try { await handler() } finally { ipcRenderer.send(IPC.send.rendererToMain.notesFlushed) }
    }
    ipcRenderer.on(IPC.event.mainToRenderer.notesFlush, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.notesFlush, wrapped)
  }
})

// Chat events
contextBridge.exposeInMainWorld('chat', {
  onTranslucenceUpdate: (handler: (value: number) => void) => {
    const wrapped = (_evt: any, value: number) => handler(value)
    ipcRenderer.on(IPC.event.mainToRenderer.chatUpdateTranslucence, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatUpdateTranslucence, wrapped)
  },

  onStreamChunk: (handler: (chunk: string) => void) => {
    const wrapped = (_evt: any, chunk: string) => handler(chunk)
    ipcRenderer.on(IPC.event.mainToRenderer.chatStreamChunk, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatStreamChunk, wrapped)
  },
  onStreamDone: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatStreamDone, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatStreamDone, wrapped)
  },
  onStreamError: (handler: (error: string) => void) => {
    const wrapped = (_evt: any, error: string) => handler(error)
    ipcRenderer.on(IPC.event.mainToRenderer.chatStreamError, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatStreamError, wrapped)
  },
  onScreenshotSelected: (handler: (data: { id: string; filePath: string; timestamp: number }) => void) => {
    const wrapped = (_evt: any, data: any) => handler(data)
    ipcRenderer.on(IPC.event.mainToRenderer.screenshotSelected, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.screenshotSelected, wrapped)
  },
  onStealthThemeUpdate: (handler: (enabled: boolean) => void) => {
    const wrapped = (_evt: any, enabled: boolean) => handler(enabled)
    ipcRenderer.on(IPC.event.mainToRenderer.chatUpdateStealthTheme, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatUpdateStealthTheme, wrapped)
  },
  onClickThroughUpdate: (handler: (enabled: boolean) => void) => {
    const wrapped = (_evt: any, enabled: boolean) => handler(enabled)
    ipcRenderer.on(IPC.event.mainToRenderer.chatUpdateClickThrough, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatUpdateClickThrough, wrapped)
  },

  onTransparencyIncrease: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatTransparencyIncrease, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatTransparencyIncrease, wrapped)
  },
  onTransparencyDecrease: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatTransparencyDecrease, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatTransparencyDecrease, wrapped)
  },
  // Dictation state events for chat window
  onDictationStart: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatDictationStart, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatDictationStart, wrapped)
  },
  onDictationStop: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.event.mainToRenderer.chatDictationStop, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatDictationStop, wrapped)
  },
  onDictationComplete: (handler: (text: string) => void) => {
    const wrapped = (_evt: any, text: string) => handler(text)
    ipcRenderer.on(IPC.event.mainToRenderer.chatDictationComplete, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.chatDictationComplete, wrapped)
  }
})

// Personal Notes events
contextBridge.exposeInMainWorld('notes', {
  onTransparencyUpdate: (handler: (opacity: number) => void) => {
    const wrapped = (_evt: any, opacity: number) => handler(opacity)
    ipcRenderer.on(IPC.event.mainToRenderer.notesUpdateTransparency, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.notesUpdateTransparency, wrapped)
  },
  onStealthModeUpdate: (handler: (enabled: boolean, darkTheme: boolean) => void) => {
    const wrapped = (_evt: any, enabled: boolean, darkTheme: boolean) => handler(enabled, darkTheme)
    ipcRenderer.on(IPC.event.mainToRenderer.notesUpdateStealthMode, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.notesUpdateStealthMode, wrapped)
  },
  onContentUpdated: (handler: (content: string) => void) => {
    const wrapped = (_evt: any, content: string) => handler(content)
    ipcRenderer.on(IPC.event.mainToRenderer.notesContentUpdated, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.notesContentUpdated, wrapped)
  },
  onRecordingStatusUpdate: (handler: (isRecording: boolean) => void) => {
    const wrapped = (_evt: any, isRecording: boolean) => handler(isRecording)
    ipcRenderer.on(IPC.event.mainToRenderer.notesRecordingStatusUpdate, wrapped)
    return () => ipcRenderer.removeListener(IPC.event.mainToRenderer.notesRecordingStatusUpdate, wrapped)
  },
  updateContent: (content: string) => ipcRenderer.invoke(IPC.invoke.notes.updateContent, content),
  getContent: () => ipcRenderer.invoke(IPC.invoke.notes.getContent),
  requestSettings: () => ipcRenderer.invoke(IPC.invoke.notes.requestSettings),
  stopRecording: () => ipcRenderer.invoke(IPC.invoke.notes.stopRecording)
})

// Expose minimal env info for platform-based defaults
contextBridge.exposeInMainWorld('env', {
  platform: process.platform
})

// Provide a TypeScript type for the renderer to import if desired
declare global {
  interface Window {
    lifecycle?: {
      onFlushRequest: (handler: () => Promise<void> | void) => () => void
    }
    electronAPI: {
      // Batch WAV recording
      wavrecStart: () => Promise<{ ok: boolean; recordingId?: string; message?: string }>
      wavrecChunkPCM16: (pcm: ArrayBuffer) => Promise<{ ok: boolean; bytes?: number; message?: string }>
      wavrecStop: () => Promise<{ ok: boolean; recordingId?: string; bytes?: number; message?: string }>
      // WebM streaming recording
      webmrecStart: () => Promise<{ ok: boolean; recordingId?: string; message?: string }>
      webmrecChunk: (chunk: ArrayBuffer) => void
      webmrecStop: () => Promise<{ ok: boolean; recordingId?: string; bytes?: number; message?: string }>
      apiTranscribe: (recordingId: string, opts?: { deleteInput?: boolean; isAIMode?: boolean; isMeetingMode?: boolean }) => Promise<{ ok: boolean; text?: string; language?: string; message?: string; details?: string }>
      apiTranscribeBuffer: (wavBuffer: ArrayBuffer, opts?: { isAIMode?: boolean }) => Promise<{ ok: boolean; text?: string; message?: string }>
      // Deepgram Nova-3 dictation (faster, with Groq fallback)
      deepgramTranscribeDictation: (wavBuffer: ArrayBuffer) => Promise<{ ok: boolean; text?: string; provider?: string; message?: string }>
      // Deepgram Direct WebSocket streaming (fastest)
      deepgramGetToken: () => Promise<{ ok: boolean; token?: string; expiresIn?: number; message?: string }>
      deepgramStartStream: (token: string) => Promise<{ ok: boolean; alreadyActive?: boolean; message?: string }>
      deepgramSendChunk: (chunk: ArrayBuffer) => Promise<{ ok: boolean; message?: string }>
      deepgramStopStream: () => Promise<{ ok: boolean; text?: string; message?: string }>
      onDeepgramTranscript: (handler: (data: { interim: string; final: string; isFinal: boolean }) => void) => () => void

      promptStart: () => Promise<{ ok: boolean }>
      promptDismiss: (ms: number) => Promise<{ ok: boolean }>
      zoomGet: () => Promise<{ ok: boolean; factor?: number }>
      zoomSet: (factor: number) => Promise<{ ok: boolean; factor?: number }>
      zoomDelta: (delta: number) => Promise<{ ok: boolean; factor?: number }>
      prefsUpdate: (p: Partial<{ cueVisual: boolean; cueAudio: boolean; cueVolume: number; keepRecordings: boolean; meetingAware: boolean; chatTranslucence: number; aiDictationModel: string; stealthMode: boolean; stealthScreenCaptureBlock: boolean; stealthClickThrough: boolean; stealthDarkTheme: boolean; chatOverlayHoverable: boolean; chatOverlayMinimal: boolean; chatOverlayTextCursor: boolean; openAtStartup: boolean; dictationLanguage: string }>) => Promise<{ ok: boolean; prefs?: any; message?: string }>
      prefsGet: () => Promise<{ ok: boolean; prefs?: any; message?: string }>
      onPrefsUpdate: (handler: (prefs: any) => void) => () => void
      prefsTestTones: () => Promise<{ ok: boolean; message?: string }>
      logsShare: () => Promise<{ ok: boolean; path?: string; message?: string }>
      shortcutsGet: () => Promise<{ ok: boolean; shortcuts?: any; message?: string }>
      shortcutsUpdate: (updates: Record<string, string>) => Promise<{ ok: boolean; shortcuts?: any; message?: string }>
      shortcutsReset: () => Promise<{ ok: boolean; shortcuts?: any; message?: string }>
      shortcutsToggle: (actionName: string, enabled: boolean) => Promise<{ ok: boolean; enabled?: boolean; message?: string }>
      shortcutsGetDisabled: () => Promise<{ ok: boolean; disabled?: string[]; message?: string }>
      setHoldShortcutsEnabled: (enabled: boolean) => Promise<{ ok: boolean; message?: string }>
      // Mic-app ignore list management
      meetingAppsGetDefaults: () => Promise<{ ok: boolean; apps?: Record<string, string[]>; categories?: string[]; message?: string }>
      meetingAppsGetCustom: () => Promise<{ ok: boolean; ignoredApps?: string[]; customApps?: string[]; message?: string }>
      meetingAppsAddCustom: (appName: string) => Promise<{ ok: boolean; ignoredApps?: string[]; customApps?: string[]; message?: string }>
      meetingAppsRemoveCustom: (appName: string) => Promise<{ ok: boolean; ignoredApps?: string[]; customApps?: string[]; message?: string }>
      notesList: () => Promise<{ ok: boolean; items?: { id: string; name: string; mtime: number; size: number; preview: string; createdAt: number }[]; message?: string }>
      notesRead: (id: string) => Promise<{ ok: boolean; text?: string; message?: string }>
      notesSave: (id: string, text: string) => Promise<{ ok: boolean; message?: string }>
      notesDelete: (id: string) => Promise<{ ok: boolean; message?: string }>
      notesRename: (id: string, nextId: string) => Promise<{ ok: boolean; message?: string }>
      notesCreate: (params: { title?: string; summary?: string; transcript?: string; notes?: string }) => Promise<{ ok: boolean; id?: string; message?: string }>
      apiSummarize: (transcript: string, notes?: string) => Promise<{ ok: boolean; text?: string; message?: string; details?: string }>
      exportSaveAs: (args: { suggestedName?: string; text: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ ok: boolean; path?: string; message?: string }>
      statsGet: () => Promise<{ ok: boolean; stats?: any; message?: string }>
      statsUpdate: (update: { wordsDictated?: number; dictationTimeSeconds?: number; meetingsTranscripted?: number }) => Promise<{ ok: boolean; stats?: any; message?: string }>
      statsReset: () => Promise<{ ok: boolean; stats?: any; message?: string }>
      onStatsUpdate: (handler: (stats: any) => void) => () => void
      activityGet: () => Promise<{ ok: boolean; logs?: any[]; message?: string }>
      activityAdd: (log: { text: string; icon: string; type?: string; fullText?: string; durationSeconds?: number }) => Promise<{ ok: boolean; message?: string }>
      activityDelete: (timestamp: number) => Promise<{ ok: boolean; message?: string }>
      onActivityUpdate: (handler: (logs: any[]) => void) => () => void
      trainerGetOverview: () => Promise<{ ok: boolean; overview?: any; message?: string }>
      trainerAnalyzeNote: (noteId: string) => Promise<{ ok: boolean; analysis?: any; message?: string }>
      chatSend: (params: { messages: any[]; stream?: boolean; manualNoteIds?: string[]; searchAllNotes?: boolean }) => Promise<{ ok: boolean; text?: string; message?: string; streaming?: boolean; sources?: { noteIds: string[]; sourceMap: Record<string, string> } }>
      chatOpenFilePicker: () => Promise<{ ok: boolean; filePaths?: string[]; message?: string }>
      chatPrepareAttachments: (filePaths: string[]) => Promise<{ ok: boolean; attachments?: ChatAttachment[]; message?: string }>
      chatMinimize: () => Promise<{ ok: boolean }>
      chatClose: () => Promise<{ ok: boolean }>
      chatToggle: () => Promise<{ ok: boolean }>
      chatResize: (height: number) => Promise<{ ok: boolean; message?: string }>
      chatAbort: () => Promise<{ ok: boolean; message?: string }>
      chatDictationToggle: () => Promise<{ ok: boolean; active?: boolean; message?: string }>
      clipboardRead: () => Promise<string>
      getLastTranscript: () => Promise<string>

      onHudUpdate?: (handler: (update: { vis?: boolean; audio?: boolean; kind?: string; mode?: string; vol?: number; text?: string }) => void) => () => void
      hudUpdate?: (update: { vis?: boolean; audio?: boolean; kind?: string; mode?: string; vol?: number; text?: string; audioLevels?: number[] }) => Promise<{ ok: boolean; message?: string }>
      hudUpdateFast?: (update: { audioLevels?: number[] }) => void
      dictationCloseHUD: () => Promise<{ ok: boolean; message?: string }>
      stealthToggle: () => Promise<{ ok: boolean; enabled?: boolean; message?: string }>
      stealthToggleClickThrough: () => Promise<{ ok: boolean; enabled?: boolean; message?: string }>
      trayUpdateRecordingState: (recording: boolean) => Promise<{ ok: boolean }>
      trayUpdateAudioMode: (mode: 'mic' | 'system' | 'both') => Promise<{ ok: boolean }>
      openExternal: (url: string) => Promise<{ ok: boolean; message?: string }>
      debugLog: (message: string) => Promise<{ ok: boolean; message?: string }>
      dictationMicError: () => Promise<{ ok: boolean; message?: string }>
      aimodeMicError: () => Promise<{ ok: boolean; message?: string }>
      deleteTempRecording: (recordingId: string) => Promise<{ ok: boolean; message?: string }>
      meetingPause: () => Promise<{ ok: boolean; message?: string }>
      meetingResume: () => Promise<{ ok: boolean; message?: string }>
      meetingStopFromHUD: () => Promise<{ ok: boolean; message?: string }>
      meetingUpdateAudioActivity: () => Promise<{ ok: boolean; message?: string }>
      meetingCaptureStarted: () => Promise<{ ok: boolean; message?: string }>
      screenshotCapture: () => Promise<{ ok: boolean; screenshot?: { id: string; filePath: string; timestamp: number }; message?: string }>
      screenshotGetBase64: (id: string) => Promise<{ ok: boolean; base64?: string; message?: string }>
      notesOpenWindow: () => Promise<{ ok: boolean; message?: string }>
      notesHideWindow: () => Promise<{ ok: boolean; message?: string }>
      notesCloseWindow: () => Promise<{ ok: boolean; message?: string }>
      // Database
      saveChat: (id: string, title: string, messages: any[]) => Promise<{ ok: boolean; message?: string }>
      getHistory: (limit?: number, offset?: number) => Promise<{ ok: boolean; chats?: any[]; message?: string }>
      getChat: (id: string) => Promise<{ ok: boolean; chat?: any; message?: string }>
      deleteChat: (id: string) => Promise<{ ok: boolean; message?: string }>
      searchChats: (query: string) => Promise<{ ok: boolean; results?: any[]; message?: string }>
      ai: {
        getSettings: () => Promise<AiSettingsSnapshot>
        setSettings: (settings: AiSettings) => Promise<AiSettingsSnapshot>
        setKey: (providerId: string, key: string) => Promise<AiSettingsSnapshot | { ok: false; message: string }>
        listModels: (providerId: string) => Promise<{ ok: boolean; models: string[]; message?: string }>
      }
      onOpacityAdjust: (handler: (delta: number) => void) => () => void
      onChatShortcutSend: (handler: () => void) => () => void
      onChatShortcutNew: (handler: () => void) => () => void
      onScreenshotCaptured: (handler: (screenshot: { id: string; filePath: string; timestamp: number }) => void) => () => void
      permissions: {
        getStatus: () => Promise<any>
        getWizardState: () => Promise<OnboardingWizardState>
        checkStep: (step: PermissionGroupId) => Promise<any>
        openStepSettings: (step: PermissionGroupId) => Promise<any>
        restartAndResume: () => Promise<{ ok: boolean; message?: string }>
        resetOnboarding: () => Promise<{ ok: boolean; message?: string }>
        getDebugInfo: () => Promise<any>
        probeScreenRecording: () => Promise<any>
        requestMicrophone: () => Promise<boolean>
        requestAccessibility: () => Promise<boolean>
        requestAutomation: () => Promise<boolean>
        requestInputMonitoring: () => Promise<boolean>
        openScreenRecordingPreferences: () => Promise<any>
        openMicrophonePreferences: () => Promise<any>
        openAccessibilityPreferences: () => Promise<any>
        openAutomationPreferences: () => Promise<any>
        openInputMonitoringPreferences: () => Promise<any>
        acknowledgeSystemAudioCapturePreflight: (preflightStarted?: boolean) => Promise<{ ok: boolean; message?: string }>
        completeOnboarding: () => Promise<any>
        needsOnboarding: () => Promise<boolean>
        reinitializeHoldShortcuts: () => Promise<{ ok: boolean; message?: string; needsRestart?: boolean }>
      }
    }
    progress: { onLog: (handler: (message: string) => void) => () => void }
    ui: {
      onRecord: (handler: () => void) => () => void
      onAutoStop: (handler: () => void) => () => void
      onStartRecording: (handler: () => void) => () => void
      onTrayStartRecording: (handler: () => void) => () => void
      onTrayStopRecording: (handler: () => void) => () => void
      onTrayAudioModeChanged: (handler: (mode: 'mic' | 'system' | 'both') => void) => () => void
      onRecordingPaused: (handler: () => void) => () => void
      onRecordingResumed: (handler: () => void) => () => void
    }
    dictation: {
      onStart: (handler: () => void) => () => void
      onStop: (handler: () => void) => () => void
      paste: (text: string) => Promise<{ ok: boolean; message?: string }>
    }
    aimode: {
      onStart: (handler: () => void) => () => void
      onStop: (handler: () => void) => () => void
      paste: (text: string) => Promise<{ ok: boolean; message?: string }>
    }
    chat: {
      onTranslucenceUpdate: (handler: (value: number) => void) => () => void
      onStreamChunk: (handler: (chunk: string) => void) => () => void
      onStreamDone: (handler: () => void) => () => void
      onStreamError: (handler: (error: string) => void) => () => void
      onScreenshotSelected: (handler: (data: { id: string; filePath: string; timestamp: number }) => void) => () => void
      onStealthThemeUpdate: (handler: (enabled: boolean) => void) => () => void
      onClickThroughUpdate: (handler: (enabled: boolean) => void) => () => void
      onTransparencyIncrease: (handler: () => void) => () => void
      onTransparencyDecrease: (handler: () => void) => () => void
      onDictationStart: (handler: () => void) => () => void
      onDictationStop: (handler: () => void) => () => void
      onDictationComplete: (handler: (text: string) => void) => () => void
      chatAbort: () => Promise<{ ok: boolean; message?: string }>
    }
    env: { platform: NodeJS.Platform }
    windowControls: {
      minimize: () => Promise<{ ok: boolean }>
      toggleMaximize: () => Promise<{ ok: boolean; maximized?: boolean }>
      isMaximized: () => Promise<{ ok: boolean; maximized: boolean }>
      close: () => Promise<{ ok: boolean }>
    }

  }
}
