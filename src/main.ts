import { guardAppNavigation, isTrustedAppFrame } from './main/navigationSecurity'
import { app, BrowserWindow, powerMonitor, screen, globalShortcut, dialog, Tray, Menu, nativeImage, MenuItemConstructorOptions, systemPreferences, desktopCapturer } from 'electron'
import type { UiohookKeyboardEvent } from 'uiohook-napi'
let uIOhook: any = null
try { uIOhook = require('uiohook-napi').uIOhook } catch { }
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
// Screenshot modules (no overlay window needed - integrated into chat)
import { screenshotHelper } from './main/ScreenshotHelper'
import { keyboardShortcuts } from './main/keyboardShortcuts'
import { holdShortcuts } from './main/holdShortcuts'
import { registerScreenshotIpcHandlers } from './main/ipcHandlers'
import { queueLogLine, getLogFilePath } from './main/logging'
import { DatabaseManager } from './main/DatabaseManager'
import { createMicWatcher, IMicWatcher, type MicWatcherStatus } from './main/MicWatcher'
import { describeMicWatcherHelperResolution } from './main/MicWatcher/helperPaths'
import { DEFAULT_MEETING_APPS, getMeetingAppCategories } from './main/MicWatcher/meetingApps'
import { registerControlIpcHandlers } from './main/controlIpc'
import { registerPermissionsIpcHandlers } from './main/permissionsIpc'
import { registerSettingsIpcHandlers } from './main/settingsIpc'
import { registerDataIpcHandlers } from './main/dataIpc'
import { registerAiIpcHandlers } from './main/aiIpc'
import { isTaskConfigured } from './main/ai/aiClient'
import { NotesRepository } from './main/notesRepository'
import { registerNotesIpcHandlers } from './main/notesIpc'
import { flushNoteEdits } from './main/notesFlush'
import { registerChatIpcHandlers } from './main/chatIpc'
import { registerAudioIpcHandlers } from './main/audioIpc'
import { registerDictationIpcHandlers } from './main/dictationIpc'
import { registerTrainerIpcHandlers } from './main/trainerIpc'
import { shouldShowMicPrompt } from './main/micSessionState'
import { isAllowedTempRecordingPath, isTrustedSenderId } from './main/securityUtils'
import { TempRecordingStore } from './main/tempRecordingStore'
import { createUpdaterController } from './main/updater'
import { IPC } from './shared/ipcChannels'
import { PERMISSION_STEP_ORDER } from './shared/permissions'
import { defaultAiSettings, normalizeAiSettings } from './shared/aiProviders'
import { applyLoginItemSettings, wasLaunchedHiddenAtLogin } from './main/loginItem'
import {
  isWithinResumeGracePeriod,
  markSystemResumed,
  markSystemSuspending,
  wasMainWindowVisibleBeforeSleep,
} from './main/powerResumeGuard'


// Menus, notifications, the About panel and permission prompts use this name.
// It must be set explicitly for `npm start`, where Electron would otherwise report "Electron".
app.setName('Notto')

if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  // Without the portal, global shortcuts silently do nothing under Wayland.
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  const errorMsg = reason?.message || String(reason)
  // Log unhandled rejections
  console.error('Unhandled promise rejection:', reason)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendProgress(`Unhandled error: ${errorMsg}`)
    }
  } catch { }
})

// Route Electron cache/userData/temp to a guaranteed writeable folder (fixes Windows cache errors)
function ensureDirSync(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch { }
}
const baseDataDir = path.join(app.getPath('home'), 'notto', 'electron')
ensureDirSync(baseDataDir)
app.setPath('userData', path.join(baseDataDir, 'userData'))
app.setPath('cache', path.join(baseDataDir, 'cache'))
app.setPath('temp', path.join(baseDataDir, 'temp'))
// Prefer CPU-only and avoid GPU cache writes
// app.disableHardwareAcceleration()
// Allow autoplay for tiny notification tones (no user gesture required)
try { app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required') } catch { }

// Set App User Model ID for Windows taskbar grouping
if (process.platform === 'win32') {
  app.setAppUserModelId('com.notto.app')
}

// ============================================================================
// SINGLE INSTANCE LOCK - Must be at module level before any app initialization
// ============================================================================
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running and has received our argv via 'second-instance'.
  // app.quit() is asynchronous: 'ready' would still fire and initialize a second copy
  // (database, global shortcuts, windows, tray). Exit right away instead.
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null
let promptWindow: BrowserWindow | null = null
let cueWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let chatWindow: BrowserWindow | null = null
let chatWindowVisible = false
let chatWindowSavedBounds: Electron.Rectangle | null = null
let notesFloatWindow: BrowserWindow | null = null
let notesFloatWindowVisible = false
let notesFloatWindowSavedBounds: Electron.Rectangle | null = null
let tray: Tray | null = null
let isMeetingActive = false // Track if a meeting/recording is in progress
let isRecordingPaused = false // Track if recording is paused
let silenceDetectionTimer: NodeJS.Timeout | null = null
let lastAudioActivity = 0
let isRecording = false // Track recording state for tray menu
let currentAudioMode: 'mic' | 'system' | 'both' = 'both' // Track audio mode for tray menu
let micSuppressUntilInactive = false
let lastMicActive = false
let currentMicSessionDismissed = false // Track if current mic session was dismissed
let activeChatAbortController: AbortController | null = null
// Simple in-memory preferences; renderer can update via IPC
let prefs = {
  cueVisual: true,
  cueAudio: true,
  cueVolume: 1.0,  // Max volume by default
  keepRecordings: false,
  meetingAware: false,
  chatAlwaysOn: false,
  chatTranslucence: 50,

  ai: defaultAiSettings(),

  // Stealth mode preferences for AI chat window
  stealthMode: true,
  stealthScreenCaptureBlock: false, // Default: visible in screen shares (users can enable to hide)
  stealthClickThrough: false,
  stealthDarkTheme: true,
  chatOverlayHoverable: false,
  chatOverlayMinimal: false,
  chatOverlayTextCursor: false,
  // Auto-launch on startup
  openAtStartup: true,
  chatWindowBounds: undefined as Electron.Rectangle | undefined,
  notesWindowBounds: undefined as Electron.Rectangle | undefined,
  shortcuts: undefined as Record<string, string> | undefined,
  meetingNotificationsEnabled: true,
  // macOS permissions onboarding
  permissionsOnboardingCompleted: false,
  automationApproved: false,
  inputMonitoringApproved: false,
  systemAudioCapturePreflightAcknowledged: false,
  permissionWizard: {
    currentStep: PERMISSION_STEP_ORDER[0],
    completedSteps: [] as string[],
    pendingRestartStep: null as string | null,
    completedAt: null as number | null,
    autoCheckStep: null as string | null
  },
  // Additional apps to ignore in mic-triggered meeting detection
  ignoredMicApps: [] as string[],
  // Toggleable shortcuts state
  disabledShortcuts: [] as string[]
}

function normalizePrefsShape(nextPrefs: any) {
  const ignoredMicApps = Array.isArray(nextPrefs.ignoredMicApps)
    ? nextPrefs.ignoredMicApps
    : Array.isArray(nextPrefs.customMeetingApps)
      ? nextPrefs.customMeetingApps
      : []

  nextPrefs.ignoredMicApps = ignoredMicApps
  if ('customMeetingApps' in nextPrefs) {
    delete nextPrefs.customMeetingApps
  }

  nextPrefs.ai = normalizeAiSettings(nextPrefs.ai)
  for (const legacy of ['systemPrompt', 'aiChatModel', 'chatMultimodalModel', 'sttModel', 'dictationModel', 'lastUsedEmail']) {
    delete nextPrefs[legacy]
  }

  if (!Array.isArray(nextPrefs.disabledShortcuts)) {
    nextPrefs.disabledShortcuts = []
  }

  const existingWizard = nextPrefs.permissionWizard || {}
  const completedSteps = Array.isArray(existingWizard.completedSteps)
    ? existingWizard.completedSteps.filter((step: string) => PERMISSION_STEP_ORDER.includes(step as any))
    : []

  nextPrefs.permissionWizard = {
    currentStep: PERMISSION_STEP_ORDER.includes(existingWizard.currentStep)
      ? existingWizard.currentStep
      : PERMISSION_STEP_ORDER[0],
    completedSteps,
    pendingRestartStep: PERMISSION_STEP_ORDER.includes(existingWizard.pendingRestartStep)
      ? existingWizard.pendingRestartStep
      : null,
    completedAt: typeof existingWizard.completedAt === 'number' ? existingWizard.completedAt : null,
    autoCheckStep: PERMISSION_STEP_ORDER.includes(existingWizard.autoCheckStep)
      ? existingWizard.autoCheckStep
      : null
  }

  if (nextPrefs.permissionsOnboardingCompleted === true && nextPrefs.permissionWizard.completedSteps.length === 0) {
    nextPrefs.permissionWizard.completedSteps = [...PERMISSION_STEP_ORDER]
    nextPrefs.permissionWizard.currentStep = null
    nextPrefs.permissionWizard.completedAt = nextPrefs.permissionWizard.completedAt || Date.now()
  }
}

function isModifierOnlyHoldShortcut(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'unbound') return false

  const modifiers = new Set(['COMMAND', 'COMMANDORCONTROL', 'CONTROL', 'CTRL', 'OPTION', 'ALT', 'SHIFT', 'META', 'SUPER', 'WIN'])
  return trimmed.split('+').every(part => modifiers.has(part.trim().toUpperCase()))
}

type ScreenRecordingStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
type ManualPermissionState = 'not-determined' | 'confirmed'

async function probeScreenRecording(): Promise<{
  status: ScreenRecordingStatus
  effective: boolean
  sourceCount: number
  validThumbnailCount: number
  error?: string
}> {
  let status = systemPreferences.getMediaAccessStatus('screen') as ScreenRecordingStatus
  let sourceCount = 0
  let validThumbnailCount = 0
  let effective = false

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2, height: 2 }
    })

    sourceCount = sources.length
    validThumbnailCount = sources.filter((source) => source.thumbnail && !source.thumbnail.isEmpty()).length

    effective = sourceCount > 0 && validThumbnailCount > 0

    // If the probe succeeded, treat it as granted regardless of the cached status
    if (effective) {
      status = 'granted'
    }
  } catch (err: any) {
    return {
      status,
      effective: false,
      sourceCount,
      validThumbnailCount,
      error: err?.message || String(err)
    }
  }

  return { status, effective, sourceCount, validThumbnailCount }
}

const prefsPath = path.join(app.getPath('userData'), 'prefs.json')

function savePrefs() {
  try {
    normalizePrefsShape(prefs)
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2))
  } catch (e) {
    console.error('Failed to save prefs:', e)
  }
}

function loadPrefs() {
  try {
    if (fs.existsSync(prefsPath)) {
      const data = fs.readFileSync(prefsPath, 'utf8')
      const loaded = JSON.parse(data)
      prefs = { ...prefs, ...loaded }
      normalizePrefsShape(prefs)

      // Apply loaded shortcuts
      if ((prefs as any).shortcuts) {
        try {
          const loadedShortcuts = (prefs as any).shortcuts
          // Migration: On macOS, clear old Windows-style hold shortcuts so new defaults take effect
          if (process.platform === 'darwin') {
            const oldShortcuts = loadedShortcuts
            if (oldShortcuts.dictationHold?.includes('Meta') ||
              oldShortcuts.aiModeHold?.includes('Meta')) {
              // Old Windows-style shortcuts detected, remove them for macOS migration
              delete oldShortcuts.dictationHold
              delete oldShortcuts.aiModeHold
              console.log('Migrated old Windows-style hold shortcuts to new macOS defaults')
            }
          }
          if (isModifierOnlyHoldShortcut(loadedShortcuts.dictationHold)) {
            loadedShortcuts.dictationHold = 'unbound'
          }
          if (isModifierOnlyHoldShortcut(loadedShortcuts.aiModeHold)) {
            loadedShortcuts.aiModeHold = 'unbound'
          }
          keyboardShortcuts.updateConfig(loadedShortcuts)
          holdShortcuts.setShortcuts(loadedShortcuts)
          if ((prefs as any).disabledShortcuts) {
            keyboardShortcuts.setDisabledActions((prefs as any).disabledShortcuts)
            holdShortcuts.setDisabledActions((prefs as any).disabledShortcuts)
          }
        } catch (e) {
          console.error('Failed to apply loaded shortcuts:', e)
        }
      }
    }
  } catch (e) {
    console.error('Failed to load prefs:', e)
  }
}
// Last transcript storage for AI chat context
let lastTranscriptText = ''
let lastSummaryText = ''



const APP_ICON_PATH = path.join(__dirname, '..', 'logos', 'icon.png')

/** Windows API bindings for stealth mode (screen capture exclusion). Windows only. */
function loadUser32() {
  const { User32 } = require('win32-api') as typeof import('win32-api')
  return User32.load()
}

// Dictation state variables (moved to module scope)
let dictationActive = false
let aiModeActive = false
let handsFreeActive = false
let keepHudUntilPaste = false // keep HUD visible showing Processing until paste completes
let hudCloseTimeout: NodeJS.Timeout | null = null // timeout to auto-close HUD if no paste occurs
let dictationStartTime = 0 // Track when dictation/Agentic Dictation started
let aiModeStartTime = 0 // Track when Agentic Dictation started
let aiModeScreenshotId: string | null = null // Screenshot ID captured when AI mode starts
let chatInitiatedDictation = false // Track when dictation was initiated from chat window
let dictationOrigin: 'global' | 'chat' = 'global'
let lastHudAudioAt = 0

function sendProgress(message: string) {
  try {
    const ts = new Date().toLocaleTimeString()
    const line = `[${ts}] ${message}`
    mainWindow?.webContents.send(IPC.event.mainToRenderer.progressLog, line)
    queueLogLine(line)
  } catch { }
}

const UPDATE_RELEASES_URL = 'https://github.com/matei-anghel/notto/releases/latest'

const updaterController = createUpdaterController({
  sendProgress,
  getMainWindow: () => mainWindow,
  getIsQuitting: () => isQuitting,
  releasesUrl: UPDATE_RELEASES_URL
})

const notesRepository = new NotesRepository({
  userDataDir: app.getPath('userData'),
  sendProgress,
  hooks: {
    onDelete: async (id) => {
      DatabaseManager.getInstance().deleteTrainerAnalysisCache(id)
    },
    onRename: async (id, nextId) => {
      DatabaseManager.getInstance().renameTrainerAnalysisCache(id, nextId)
    }
  }
})

function getTrustedWindowIds(): number[] {
  return [
    mainWindow,
    promptWindow,
    cueWindow,
    hudWindow,
    chatWindow,
    notesFloatWindow
  ]
    .filter((win): win is BrowserWindow => !!win && !win.isDestroyed())
    .map((win) => win.id)
}

function isTrustedRendererEvent(evt: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  try {
    if (!isTrustedAppFrame(evt, path.join(__dirname, '..'))) return false
    const senderWin = BrowserWindow.fromWebContents(evt.sender)
    return !!senderWin && isTrustedSenderId(senderWin.id, getTrustedWindowIds())
  } catch {
    return false
  }
}

function blockedInvokeResult<T extends Record<string, any>>(fallback?: T): T & { ok: false; message: string } {
  return {
    ...(fallback ?? {} as T),
    ok: false,
    message: 'blocked'
  }
}

async function runProgress(cmd: string, args: string[], opts: SpawnOptions = {}, onData?: (stream: 'stdout' | 'stderr', data: string) => void) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => {
      const s = d.toString()
      stdout += s
      onData?.('stdout', s)
    })
    child.stderr?.on('data', (d) => {
      const s = d.toString()
      stderr += s
      onData?.('stderr', s)
    })
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

let lastAutomationVerificationAt = 0

async function verifyAutomationPermissionNow(): Promise<boolean> {
  if (process.platform !== 'darwin') return true

  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      const osa = spawn('osascript', [
        '-e',
        'tell application "System Events" to get name of every process'
      ], { stdio: ['ignore', 'ignore', 'ignore'] })

      osa.on('error', () => finish(false))
      osa.on('close', (code) => finish(code === 0))
      setTimeout(() => finish(false), 1500)
    } catch {
      finish(false)
    }
  })
}

async function reverifyManualPermissions(force = false): Promise<void> {
  if (process.platform !== 'darwin') return

  const accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(false)

  if ((prefs as any).automationApproved === true) {
    const now = Date.now()
    if (force || now - lastAutomationVerificationAt >= 15000) {
      lastAutomationVerificationAt = now
      const verified = await verifyAutomationPermissionNow()
      if (!verified) {
        sendProgress('Automation access may need repair in System Settings')
      }
    }
  }

  if ((prefs as any).inputMonitoringApproved === true && accessibilityTrusted && !holdShortcuts.isActive()) {
    const ok = holdShortcuts.reinitialize()
    if (!ok) {
      sendProgress('Hold shortcuts need repair or restart')
    }
  }
}

async function safeUnlink(file: string) {
  try { await fsp.unlink(file) } catch { }
}

// Startup janitor: delete stale WAVs from temp dir
async function janitorSweepTempWavs(maxAgeDays = 3) {
  try {
    const wavDir = path.join(app.getPath('temp'), 'notto')
    await fsp.mkdir(wavDir, { recursive: true }).catch(() => { })
    const entries = await fsp.readdir(wavDir).catch(() => [])
    const now = Date.now()
    const maxAgeMs = Math.max(1, Math.floor(maxAgeDays)) * 24 * 60 * 60 * 1000
    let deleted = 0
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.wav')) continue
      const p = path.join(wavDir, name)
      try {
        const st = await fsp.stat(p)
        if (now - st.mtimeMs > maxAgeMs) {
          await fsp.unlink(p).catch(() => { })
          deleted++
        }
      } catch { }
    }
    if (deleted > 0) { }
  } catch (e: any) {
    sendProgress(`Janitor error: ${e?.message ?? 'Error'}`)
  }
}

const tempRecordingStore = new TempRecordingStore()

function configureHudWindow(win: BrowserWindow) {
  win.setAlwaysOnTop(true, 'screen-saver') // Ensure it stays on top
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    if (hudWindow === win) hudWindow = null
  })
  win.webContents.on('render-process-gone', () => {
    if (hudWindow === win) {
      try { win.destroy() } catch { }
      hudWindow = null
    }
  })
}

function getHudDisplay() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch {
    return screen.getPrimaryDisplay()
  }
}

function getHudWorkArea(disp: Electron.Display) {
  // Use workArea on all platforms to respect dock/taskbar
  // This ensures the HUD doesn't overlap with the dock on macOS
  // or the taskbar on Windows/Linux
  return disp.workArea
}

function getHudPosition(width: number, height: number, bottomMargin = 6) {
  const disp = getHudDisplay()
  const area = getHudWorkArea(disp)
  const x = Math.floor(area.x + (area.width - width) / 2)
  const y = Math.floor(area.y + area.height - height - bottomMargin)
  return { x, y }
}

function getDisplayForBounds(bounds?: Electron.Rectangle | null) {
  try {
    if (bounds) {
      const center = {
        x: Math.floor(bounds.x + bounds.width / 2),
        y: Math.floor(bounds.y + bounds.height / 2)
      }
      return screen.getDisplayNearestPoint(center)
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch {
    return screen.getPrimaryDisplay()
  }
}

function clampBoundsToDisplay(
  bounds: Electron.Rectangle,
  options?: { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number; margin?: number }
) {
  const display = getDisplayForBounds(bounds)
  const area = display.workArea
  const margin = options?.margin ?? 12
  const minWidth = options?.minWidth ?? 100
  const minHeight = options?.minHeight ?? 60
  const maxWidth = Math.max(minWidth, Math.min(options?.maxWidth ?? Number.MAX_SAFE_INTEGER, area.width - margin * 2))
  const maxHeight = Math.max(minHeight, Math.min(options?.maxHeight ?? Number.MAX_SAFE_INTEGER, area.height - margin * 2))
  const width = Math.max(minWidth, Math.min(bounds.width, maxWidth))
  const height = Math.max(minHeight, Math.min(bounds.height, maxHeight))
  const minX = area.x + margin
  const maxX = area.x + area.width - width - margin
  const minY = area.y + margin
  const maxY = area.y + area.height - height - margin
  const x = maxX >= minX ? Math.min(Math.max(bounds.x, minX), maxX) : area.x
  const y = maxY >= minY ? Math.min(Math.max(bounds.y, minY), maxY) : area.y
  return { x, y, width, height }
}

function getDefaultChatBounds(sourceBounds?: Electron.Rectangle | null) {
  const area = getDisplayForBounds(sourceBounds).workArea
  const width = 520
  const height = 60
  return clampBoundsToDisplay({
    x: Math.floor(area.x + (area.width - width) / 2),
    y: area.y + 20,
    width,
    height
  }, { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
}

function getSavedChatBounds(sourceBounds?: Electron.Rectangle | null) {
  return (prefs as any).chatWindowBounds || chatWindowSavedBounds || getDefaultChatBounds(sourceBounds)
}

function persistChatWindowBounds(bounds: Electron.Rectangle) {
  const clampedBounds = clampBoundsToDisplay(bounds, { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
  chatWindowSavedBounds = clampedBounds
  ; (prefs as any).chatWindowBounds = clampedBounds
  savePrefs()
  return clampedBounds
}

function getDefaultNotesBounds(sourceBounds?: Electron.Rectangle | null) {
  const area = getDisplayForBounds(sourceBounds).workArea
  const width = 400
  const height = 500
  return clampBoundsToDisplay({
    x: area.x + area.width - width - 20,
    y: Math.floor(area.y + Math.max(20, Math.min(area.height - height - 20, area.height * 0.5))),
    width,
    height
  }, { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
}

function applyClampedWindowBounds(
  win: BrowserWindow | null,
  bounds: Electron.Rectangle,
  options?: { minWidth?: number; minHeight?: number; maxWidth?: number; maxHeight?: number; margin?: number; animate?: boolean }
) {
  if (!win || win.isDestroyed()) return
  const nextBounds = clampBoundsToDisplay(bounds, options)
  win.setBounds(nextBounds, options?.animate === true)
}

function showOverlayWindow(win: BrowserWindow | null, focus = true) {
  if (!win || win.isDestroyed()) return
  if (typeof win.showInactive === 'function' && !focus) {
    win.showInactive()
    return
  }
  win.show()
  if (focus) {
    win.focus()
  }
}

function hideChatOverlayWindow() {
  if (!chatWindow || chatWindow.isDestroyed()) return
  persistChatWindowBounds(chatWindow.getBounds())
  chatWindowVisible = false
  if (process.platform === 'darwin') {
    chatWindow.hide()
  } else {
    chatWindow.setPosition(-10000, -10000)
  }
}

function hideNotesOverlayWindow() {
  if (!notesFloatWindow || notesFloatWindow.isDestroyed()) return
  notesFloatWindowSavedBounds = clampBoundsToDisplay(notesFloatWindow.getBounds(), { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
  if (process.platform === 'darwin') {
    notesFloatWindow.hide()
  } else {
    notesFloatWindow.setPosition(-10000, -10000)
    notesFloatWindow.setIgnoreMouseEvents(true, { forward: true })
  }
  notesFloatWindowVisible = false
}

function clampVisibleFloatingWindows() {
  if (isWithinResumeGracePeriod()) {
    restoreMainWindowVisibilityAfterSleep()
  }
  if (chatWindow && !chatWindow.isDestroyed()) {
    const sourceBounds = chatWindowVisible
      ? chatWindow.getBounds()
      : getSavedChatBounds(chatWindow.getBounds())
    const clamped = persistChatWindowBounds(sourceBounds)
    if (chatWindowVisible) {
      chatWindow.setBounds(clamped)
    }
  }
  if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
    const sourceBounds = notesFloatWindowVisible
      ? notesFloatWindow.getBounds()
      : (notesFloatWindowSavedBounds || (prefs as any).notesWindowBounds || notesFloatWindow.getBounds())
    const clamped = clampBoundsToDisplay(sourceBounds, { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
    notesFloatWindowSavedBounds = clamped
    if (notesFloatWindowVisible) {
      notesFloatWindow.setBounds(clamped)
    }
    ; (prefs as any).notesWindowBounds = clamped
    savePrefs()
  }
}

/** Briefly show a text-only HUD message, e.g. when a feature still needs an AI provider. */
function showHudNotice(text: string, mode: 'dictation' | 'ai') {
  sendProgress(text)
  const width = 450
  const height = 38
  const update = { vis: true, audio: false, kind: 'notice', mode, text }
  try {
    if (hudWindow && !hudWindow.isDestroyed()) {
      const { x } = getHudPosition(width, height)
      hudWindow.setBounds({ x, width, height, y: hudWindow.getBounds().y })
      hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, update)
      hudWindow.showInactive()
    } else {
      const { x, y } = getHudPosition(width, height)
      hudWindow = new BrowserWindow({
        width, height, x, y,
        frame: false, transparent: true, resizable: false, movable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
        backgroundColor: '#00000000', show: true,
        icon: APP_ICON_PATH,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
      })
      configureHudWindow(hudWindow)
      hudWindow.loadFile(path.join(__dirname, '..', 'hud.html'), { query: { vis: '1', a: '0', k: 'notice', mode, text } })
    }
  } catch { }
  setTimeout(() => {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide()
  }, 3000)
}

function showDictationHUD(mode: 'dictation' | 'ai' = 'dictation') {
  try {
    const width = 220
    const height = 38
    const { x, y } = getHudPosition(width, height)

    const hudCrashed = !!(hudWindow && !hudWindow.isDestroyed() && (hudWindow.webContents.isDestroyed() || hudWindow.webContents.isCrashed()))
    if (!hudWindow || hudWindow.isDestroyed() || hudCrashed) {
      try { if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy() } catch { }
      const win = new BrowserWindow({
        width, height, x, y,
        frame: false, transparent: true, resizable: false, movable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
        backgroundColor: '#00000000',
        show: false,
        icon: APP_ICON_PATH,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
      })
      configureHudWindow(win)
      // Preload content hidden so updates are instant
      win.loadFile(path.join(__dirname, '..', 'hud.html'), { query: { vis: '0', a: '0', k: 'start', mode } })
      hudWindow = win
    } else {
      try { hudWindow.setBounds({ width, height, x, y }) } catch { }
      try { hudWindow.setAlwaysOnTop(true, 'screen-saver') } catch { }
      try { hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { }
    }

    if (!hudWindow || hudWindow.isDestroyed()) return
    const applyUpdate = () => {
      try {
        const now = Date.now()
        const playAudio = now - lastHudAudioAt > 250
        if (playAudio) lastHudAudioAt = now
        hudWindow?.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: playAudio, kind: 'start', mode })
        if (hudWindow?.showInactive) hudWindow.showInactive()
        else hudWindow?.show()
      } catch { }
    }
    if (hudWindow.webContents.isLoading()) {
      hudWindow.webContents.once('did-finish-load', () => {
        applyUpdate()
      })
    } else if (!hudWindow.webContents.getURL()) {
      hudWindow.webContents.once('did-finish-load', () => {
        applyUpdate()
      })
      hudWindow.loadFile(path.join(__dirname, '..', 'hud.html'), { query: { vis: '0', a: '0', k: 'start', mode } })
    } else {
      applyUpdate()
    }
  } catch { }
}

function hideDictationHUD() {
  // Hide HUD to keep it pre-warmed for next use
  try {
    if (hudWindow && !hudWindow.isDestroyed()) {
      hudWindow.hide()
    }
  } catch { }
}

// Tray menu builder
function buildTrayMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Notto Controls',
      enabled: false
    },
    { type: 'separator' },
    {
      label: isRecording ? '⏸ Stop Recording' : '⏺ Start Recording',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (isRecording) {
            mainWindow.webContents.send(IPC.event.mainToRenderer.trayStopRecording)
          } else {
            mainWindow.webContents.send(IPC.event.mainToRenderer.trayStartRecording)
          }
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Audio Source',
      submenu: [
        {
          label: 'Microphone + System Audio',
          type: 'radio',
          checked: currentAudioMode === 'both',
          click: () => {
            currentAudioMode = 'both'
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.event.mainToRenderer.trayAudioModeChanged, 'both')
            }
            updateTrayMenu()
          }
        },
        {
          label: 'Microphone Only',
          type: 'radio',
          checked: currentAudioMode === 'mic',
          click: () => {
            currentAudioMode = 'mic'
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.event.mainToRenderer.trayAudioModeChanged, 'mic')
            }
            updateTrayMenu()
          }
        },
        {
          label: 'System Audio Only',
          type: 'radio',
          checked: currentAudioMode === 'system',
          click: () => {
            currentAudioMode = 'system'
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(IPC.event.mainToRenderer.trayAudioModeChanged, 'system')
            }
            updateTrayMenu()
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => {
        updaterController.checkForUpdates('tray')
      }
    },
    { type: 'separator' },
    {
      label: 'Show Notto',
      click: () => {
        showMainWindow()
      }
    },
    {
      label: 'Quit Notto',
      click: () => {
        app.quit()
      }
    }
  ]

  return Menu.buildFromTemplate(template)
}

function updateTrayMenu() {
  if (tray && !tray.isDestroyed()) {
    const menu = buildTrayMenu()
    tray.setContextMenu(menu)
  }
}

function createTray() {
  try {
    // Use the custom logo for the tray icon
    const isMac = process.platform === 'darwin'
    const trayPath = isMac
      ? path.join(__dirname, '..', 'logos', 'logo black transparent.png')
      : APP_ICON_PATH
    let icon = nativeImage.createFromPath(trayPath)
    if (icon.isEmpty() && trayPath !== APP_ICON_PATH) {
      icon = nativeImage.createFromPath(APP_ICON_PATH)
    }
    if (!icon.isEmpty()) {
      // Render at 2x and mark the scale so the icon stays sharp on high-DPI displays.
      const size = isMac ? { height: 36 } : { width: 32, height: 32 }
      icon = nativeImage.createFromBuffer(icon.resize({ ...size, quality: 'best' }).toPNG(), { scaleFactor: 2 })
    }
    if (isMac) {
      try { icon.setTemplateImage(true) } catch { }
    }
    tray = new Tray(icon)

    tray.setToolTip('Notto')

    const menu = buildTrayMenu()
    tray.setContextMenu(menu)

    if (isMac) {
      tray.on('click', () => {
        showMainWindow()
      })
      tray.on('right-click', () => {
        if (tray && !tray.isDestroyed()) {
          tray.popUpContextMenu()
        }
      })
    } else {
      tray.on('click', () => {
        if (tray && !tray.isDestroyed()) {
          tray.popUpContextMenu()
        }
      })
    }

    // Double-click to show main window
    tray.on('double-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (err) {
    console.error('Failed to create tray:', err)
  }
}

function buildApplicationMenu() {
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
      {
        label: app.getName(),
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Show Notto', click: () => showMainWindow() },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: 'Quit Notto', accelerator: 'Command+Q', click: () => app.quit() }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { label: 'Show Notto', click: () => showMainWindow() },
          { role: 'front' }
        ]
      }
    ]
    : [
      {
        label: 'File',
        submenu: [
          { label: 'Show Notto', click: () => showMainWindow() },
          { type: 'separator' },
          { label: 'Quit Notto', click: () => app.quit() }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' }
        ]
      }
    ]

  return Menu.buildFromTemplate(template)
}

function shouldShowMainWindowOnReady(): boolean {
  try {
    if (wasLaunchedHiddenAtLogin()) return false
  } catch { }
  return true
}

function restoreMainWindowVisibilityAfterSleep(): void {
  if (wasMainWindowVisibleBeforeSleep()) return
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
  mainWindow.hide()
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    frame: isMac,
    icon: APP_ICON_PATH,
    ...(isMac
      ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 14, y: 14 }
      }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    },
    show: false
  })

  // Show window only when ready to prevent flicker
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed() && shouldShowMainWindowOnReady()) {
      mainWindow.show()
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'))

  // Keep background services alive when closing the main window
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  // Windows logoff/shutdown: let the window close instead of hiding it to the tray.
  mainWindow.on('session-end', () => {
    isQuitting = true
  })

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()
  mainWindow.on('closed', () => {
    mainWindow = null
  })

}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

// ============================================================================
// Stealth Mode Functions for AI Chat Window
// ============================================================================

const WDA_EXCLUDEFROMCAPTURE = 0x00000011

/**
 * Shared helper for applying Windows screen-capture exclusion to a window.
 */
function setWindowScreenCaptureProtection(window: BrowserWindow | null, enable: boolean, windowName: string) {
  if (!window || window.isDestroyed()) return

  try {
    const hwnd = window.getNativeWindowHandle()
    if (!hwnd) return

    // Convert Buffer to integer handle
    const handle = hwnd.readInt32LE(0)

    if (process.platform === 'win32') {
      const user32 = loadUser32()
      // Using dynamic call as the type definitions may not include this function
      const SetWindowDisplayAffinity = (user32 as any).SetWindowDisplayAffinity
      if (typeof SetWindowDisplayAffinity === 'function') {
        SetWindowDisplayAffinity(handle, enable ? WDA_EXCLUDEFROMCAPTURE : 0)
      }
    }
  } catch (error) {
    console.error(`Failed to set ${windowName} screen capture protection:`, error)
  }
}

/**
 * Sets screen capture exclusion on notes window using Windows SetWindowDisplayAffinity API
 * This makes the window appear as transparent/desktop background in screenshares
 */
function setChatScreenCaptureProtection(enable: boolean) {
  setWindowScreenCaptureProtection(chatWindow, enable, 'chat')
}

/**
 * Sets screen capture exclusion on notes window using Windows SetWindowDisplayAffinity API
 * This makes the window appear as transparent/desktop background in screenshares
 */
function setNotesScreenCaptureProtection(enable: boolean) {
  setWindowScreenCaptureProtection(notesFloatWindow, enable, 'notes')
}

/**
 * Sets click-through mode on chat window (forwards mouse events to windows beneath)
 */
function setChatClickThrough(enable: boolean) {
  if (!chatWindow || chatWindow.isDestroyed()) return

  try {
    if (enable) {
      chatWindow.setIgnoreMouseEvents(true, { forward: true })
    } else {
      chatWindow.setIgnoreMouseEvents(false)
    }
  } catch (error) {
    console.error('Failed to set chat click-through mode:', error)
  }
}

/**
 * Applies stealth mode settings to chat window
 */
function applyChatStealthMode() {
  if (!chatWindow || chatWindow.isDestroyed()) return

  const { stealthMode, stealthScreenCaptureBlock, stealthClickThrough } = prefs

  // Screen capture protection: use stealthScreenCaptureBlock directly (independent of stealthMode)
  // This allows users to control screen share visibility separately
  const captureEnabled = !!stealthScreenCaptureBlock
  const clickThroughEnabled = !!(stealthMode && stealthClickThrough)

  // Apply Windows-specific screen capture protection
  setChatScreenCaptureProtection(captureEnabled)

  // Apply Electron's cross-platform content protection
  try {
    chatWindow.setContentProtection(captureEnabled)
  } catch (error) {
    console.error('Failed to set content protection:', error)
  }

  setChatClickThrough(clickThroughEnabled)

  try {
    chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateClickThrough, clickThroughEnabled)
  } catch { }
}

/**
 * Applies screen capture protection to notes window (uses same setting as chat window)
 */
function applyNotesStealthMode() {
  if (!notesFloatWindow || notesFloatWindow.isDestroyed()) return

  const { stealthScreenCaptureBlock } = prefs

  // Screen capture protection: use stealthScreenCaptureBlock directly (same as chat window)
  const captureEnabled = !!stealthScreenCaptureBlock

  // Apply Windows-specific screen capture protection
  setNotesScreenCaptureProtection(captureEnabled)

  // Apply Electron's cross-platform content protection
  try {
    notesFloatWindow.setContentProtection(captureEnabled)
  } catch (error) {
    console.error('Failed to set notes content protection:', error)
  }
}

/**
 * Toggles click-through mode on/off (for keyboard shortcut)
 */
function toggleChatClickThrough() {
  prefs.stealthClickThrough = !prefs.stealthClickThrough
  applyChatStealthMode()

  // Notify renderer of state change
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.event.mainToRenderer.prefsUpdate, prefs)
  }
  savePrefs()
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (!chatWindow.isVisible()) {
      applyClampedWindowBounds(chatWindow, getSavedChatBounds(chatWindow.getBounds()), { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
      showOverlayWindow(chatWindow, false)
    }
    chatWindowVisible = true
    applyChatStealthMode()
    return
  }

  const defaultBounds = getSavedChatBounds()

  chatWindow = new BrowserWindow({
    width: defaultBounds.width,
    height: defaultBounds.height,
    minHeight: 50,
    maxHeight: 600,
    x: defaultBounds.x,
    y: defaultBounds.y,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    type: process.platform === 'darwin' ? 'panel' : 'toolbar', // Hide from taskbar/window switchers
    hiddenInMissionControl: true, // Hide from Mission Control on macOS
    title: '', // Empty title to avoid showing "AI" in window pickers
    show: false, // Don't show immediately to prevent flicker
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Show only when ready to prevent flickering
  chatWindow.once('ready-to-show', () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      applyClampedWindowBounds(chatWindow, chatWindowSavedBounds || defaultBounds, { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
      showOverlayWindow(chatWindow, false)
      chatWindowVisible = true
    }
  })

  // Set empty title after creation to ensure it's not visible
  chatWindow.setTitle('')

  chatWindow.setAlwaysOnTop(true, 'screen-saver')
  chatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Screen capture protection is controlled by stealthScreenCaptureBlock preference
  // Default is false (visible in screen shares), users can enable to hide

  // On Windows, set extended window style to exclude from window enumeration
  if (process.platform === 'win32') {
    try {
      const hwnd = chatWindow.getNativeWindowHandle()
      if (hwnd) {
        const handle = hwnd.readInt32LE(0)
        const user32 = loadUser32()
        const GWL_EXSTYLE = -20
        const WS_EX_TOOLWINDOW = 0x00000080
        const WS_EX_NOACTIVATE = 0x08000000

        // Get current extended style
        const GetWindowLongPtrW = (user32 as any).GetWindowLongPtrW || (user32 as any).GetWindowLongW
        const SetWindowLongPtrW = (user32 as any).SetWindowLongPtrW || (user32 as any).SetWindowLongW

        if (typeof GetWindowLongPtrW === 'function' && typeof SetWindowLongPtrW === 'function') {
          const currentStyle = GetWindowLongPtrW(handle, GWL_EXSTYLE)
          // Add WS_EX_TOOLWINDOW and WS_EX_NOACTIVATE to exclude from window enumeration
          const newStyle = (currentStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) >>> 0
          SetWindowLongPtrW(handle, GWL_EXSTYLE, newStyle)
        }
      }
    } catch (error) {
      console.error('Failed to set window extended style:', error)
    }
  }

  // Wait for the page to be fully ready before showing
  chatWindow.webContents.once('did-finish-load', () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      // Small delay to ensure renderer script is initialized
      setTimeout(() => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          // Send initial translucence value to the window
          const value = (prefs as any).chatTranslucence ?? 50
          chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateTranslucence, value)
          // Send initial stealth theme state (including explicit false to clear overrides)
          chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateStealthTheme, !!(prefs.stealthMode && prefs.stealthDarkTheme))
          chatWindow.webContents.send(IPC.event.mainToRenderer.chatUpdateClickThrough, !!(prefs.stealthMode && prefs.stealthClickThrough))
          applyChatStealthMode()
        }
      }, 50)
    }
  })

  // Error handling
  chatWindow.webContents.on('did-fail-load', (_evt, errorCode, errorDescription) => {
    sendProgress(`Chat window load failed: ${errorCode} - ${errorDescription}`)
  })

  // Load content
  chatWindow.loadFile(path.join(__dirname, '..', 'chat.html')).catch((err) => {
    sendProgress(`Chat window loadFile error: ${err?.message ?? String(err)}`)
  })

  chatWindow.on('closed', () => {
    chatWindow = null
    chatWindowVisible = false
  })

  const rememberChatBounds = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return
    if (!chatWindowVisible) return
    const bounds = chatWindow.getBounds()
    if (bounds.x <= -5000 || bounds.y <= -5000) return
    persistChatWindowBounds(bounds)
  }
  chatWindow.on('move', rememberChatBounds)
  chatWindow.on('resize', rememberChatBounds)

  // Apply stealth mode if enabled
  applyChatStealthMode()
}

function toggleChatWindow() {
  try {
    // ONLY toggle chat window, never touch notes window
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (chatWindowVisible) {
        hideChatOverlayWindow()
        sendProgress('AI chat window hidden')

      } else {
        applyChatStealthMode()

        applyClampedWindowBounds(chatWindow, getSavedChatBounds(chatWindow.getBounds()), { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
        try { chatWindow.setOpacity(1) } catch { }
        showOverlayWindow(chatWindow, false)
        chatWindowVisible = true
        sendProgress('AI chat window shown')
      }
    } else {
      sendProgress('Creating AI chat window...')
      createChatWindow()
    }
  } catch (e: any) {
    sendProgress(`Error toggling chat window: ${e?.message ?? String(e)}`)
  }
}

function moveChatWindow(deltaX: number, deltaY: number) {
  if (!chatWindow || chatWindow.isDestroyed()) return

  try {
    const bounds = chatWindow.getBounds()
    const nextBounds = clampBoundsToDisplay({
      ...bounds,
      x: bounds.x + deltaX,
      y: bounds.y + deltaY
    }, { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })

    if (nextBounds.x !== bounds.x || nextBounds.y !== bounds.y) {
      chatWindow.setBounds(nextBounds, true)
      persistChatWindowBounds(nextBounds)
    }
  } catch (error: any) {
    sendProgress(`Chat window move failed: ${error?.message ?? 'Error'}`)
  }
}

// Personal Notes Float Window Functions
// ============================================================================

function createNotesFloatWindow() {
  if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
    if (!notesFloatWindow.isVisible()) {
      applyClampedWindowBounds(notesFloatWindow, notesFloatWindowSavedBounds || (prefs as any).notesWindowBounds || getDefaultNotesBounds(notesFloatWindow.getBounds()), { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
      notesFloatWindow.setIgnoreMouseEvents(false)
      showOverlayWindow(notesFloatWindow)
    }
    notesFloatWindowVisible = true
    return
  }

  // Check for saved bounds
  const savedBounds = (prefs as any).notesWindowBounds || notesFloatWindowSavedBounds
  const initialBounds = clampBoundsToDisplay(savedBounds || getDefaultNotesBounds(), { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })

  notesFloatWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: 300,
    minHeight: 200,
    x: initialBounds.x,
    y: initialBounds.y,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  notesFloatWindow.setAlwaysOnTop(true, 'screen-saver')
  notesFloatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Save position on move/resize
  notesFloatWindow.on('move', () => {
    if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
      const bounds = notesFloatWindow.getBounds()
      // Ignore off-screen hide position
      if (bounds.x > -5000 && bounds.y > -5000) {
        const clampedBounds = clampBoundsToDisplay(bounds, { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
        notesFloatWindowSavedBounds = clampedBounds
        ; (prefs as any).notesWindowBounds = clampedBounds
        savePrefs()
      }
    }
  })

  notesFloatWindow.on('resize', () => {
    if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
      const bounds = notesFloatWindow.getBounds()
      if (bounds.x > -5000 && bounds.y > -5000) {
        const clampedBounds = clampBoundsToDisplay(bounds, { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
        notesFloatWindowSavedBounds = clampedBounds
        ; (prefs as any).notesWindowBounds = clampedBounds
        savePrefs()
      }
    }
  })

  // Screen capture protection is controlled by stealthScreenCaptureBlock preference
  // Default is false (visible in screen shares), users can enable to hide

  notesFloatWindow.webContents.once('did-finish-load', () => {
    if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
      setTimeout(() => {
        if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
          if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
            // Send initial transparency settings
            const opacity = (prefs as any).chatTranslucence ?? 50
            const blur = (prefs as any).chatBlur ?? 20
            notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateTransparency, opacity, blur)

            // Send stealth mode settings
            const stealthEnabled = prefs.stealthMode ?? false
            const darkTheme = prefs.stealthDarkTheme ?? false
            notesFloatWindow.webContents.send(IPC.event.mainToRenderer.notesUpdateStealthMode, stealthEnabled, darkTheme)

            // Apply screen capture protection based on preference
            applyNotesStealthMode()

            applyClampedWindowBounds(notesFloatWindow, notesFloatWindowSavedBounds || initialBounds, { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
            notesFloatWindow.setIgnoreMouseEvents(false)
            showOverlayWindow(notesFloatWindow)

            notesFloatWindowVisible = true
            sendProgress('Personal notes window ready')
          }

        }
      }, 50)
    }
  })

  notesFloatWindow.webContents.on('did-fail-load', (_evt, errorCode, errorDescription) => {
    sendProgress(`Notes float window load failed: ${errorCode} - ${errorDescription}`)
  })

  notesFloatWindow.loadFile(path.join(__dirname, '..', 'notes-float.html')).catch((err) => {
    sendProgress(`Notes float window loadFile error: ${err?.message ?? String(err)}`)
  })

  notesFloatWindow.on('closed', () => {
    notesFloatWindow = null
    notesFloatWindowVisible = false
  })

  sendProgress('Personal notes window opened')
}

function toggleNotesFloatWindow() {
  try {
    if (notesFloatWindow && !notesFloatWindow.isDestroyed()) {
      if (notesFloatWindowVisible) {
        hideNotesOverlayWindow()
        sendProgress('Personal notes window hidden')
      } else {
        applyClampedWindowBounds(notesFloatWindow, notesFloatWindowSavedBounds || (prefs as any).notesWindowBounds || getDefaultNotesBounds(notesFloatWindow.getBounds()), { minWidth: 300, minHeight: 200, maxWidth: 900, maxHeight: 900, margin: 12 })
        notesFloatWindow.setOpacity(1)
        notesFloatWindow.setIgnoreMouseEvents(false)
        // Apply screen capture protection when showing
        applyNotesStealthMode()

        showOverlayWindow(notesFloatWindow)

        notesFloatWindowVisible = true
        sendProgress('Personal notes window shown')
      }
    } else {
      sendProgress('Creating personal notes window...')
      createNotesFloatWindow()
    }
  } catch (e: any) {
    sendProgress(`Error toggling notes float window: ${e?.message ?? String(e)}`)
  }
}

// Every window must retain a local page before it can use the preload bridge.
app.on('web-contents-created', (_event, contents) => {
  guardAppNavigation(contents, path.join(__dirname, '..'))
})

app.whenReady().then(async () => {
  if (!gotTheLock) return
  app.setAboutPanelOptions({
    applicationName: 'Notto',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Notto contributors. Licensed under GPL-3.0.',
    website: 'https://github.com/matei-anghel/notto',
    iconPath: APP_ICON_PATH
  })
  if (process.platform === 'darwin') {
    try { app.setActivationPolicy('regular') } catch { }
    try { app.dock?.show() } catch { }
  }
  // Register second-instance handler (we already have the lock from module level)
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (isWithinResumeGracePeriod()) return
    showMainWindow()
  });

  loadPrefs()
  createWindow()
  createTray()
  Menu.setApplicationMenu(buildApplicationMenu())
  updaterController.setupAutoUpdater()
  updaterController.checkForUpdates('startup')
  updaterController.scheduleAutoUpdateChecks()

  screen.on('display-metrics-changed', clampVisibleFloatingWindows)
  screen.on('display-added', clampVisibleFloatingWindows)
  screen.on('display-removed', clampVisibleFloatingWindows)

  powerMonitor.on('suspend', () => {
    markSystemSuspending(!!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()))
  })

  powerMonitor.on('resume', () => {
    markSystemResumed()
    restoreMainWindowVisibilityAfterSleep()
    setTimeout(restoreMainWindowVisibilityAfterSleep, 500)
    setTimeout(restoreMainWindowVisibilityAfterSleep, 2000)
    if (!isQuitting) updaterController.checkForUpdates('background')
  })
  // AI chat window not created at startup anymore per user request
  tryStartMicWatcher()

  // Set auto-launch on startup based on preference
  try {
    applyLoginItemSettings(prefs.openAtStartup)
  } catch (err) {
    console.error('Failed to set auto-launch:', err)
  }

  // Sweep stale temp WAVs on startup (3 days retention)
  janitorSweepTempWavs(3).catch(() => { })

  // Initialize screenshot capture helper
  screenshotHelper.initialize().then(() => {
    sendProgress('Screenshot helper initialized')
  }).catch((err) => {
    sendProgress(`Screenshot helper init failed: ${err?.message ?? 'Error'}`)
  })

  // Register screenshot IPC handlers
  registerScreenshotIpcHandlers({ isTrustedRendererEvent })
  sendProgress('Screenshot IPC handlers registered')

  // Setup keyboard shortcuts handlers
  keyboardShortcuts.setHandlers({
    onChatToggle: () => {
      try {
        sendProgress('Chat shortcut triggered')
        toggleChatWindow()
      } catch (e: any) {
        sendProgress(`Error in chat shortcut handler: ${e?.message ?? String(e)}`)
      }
    },
    onChatMove: (deltaX, deltaY) => moveChatWindow(deltaX, deltaY),
    onChatSend: () => {
      if (!chatWindow || chatWindow.isDestroyed()) return
      try {
        chatWindow.webContents.send(IPC.event.mainToRenderer.chatShortcutSend)
      } catch { }
    },
    onChatNewChat: () => {
      if (!chatWindow || chatWindow.isDestroyed()) return
      try {
        chatWindow.webContents.send(IPC.event.mainToRenderer.chatShortcutNew)
      } catch { }
    },
    onChatTransparencyIncrease: () => {
      if (!chatWindow || chatWindow.isDestroyed()) return
      try {
        chatWindow.webContents.send(IPC.event.mainToRenderer.chatTransparencyIncrease)
      } catch { }
    },
    onChatTransparencyDecrease: () => {
      if (!chatWindow || chatWindow.isDestroyed()) return
      try {
        chatWindow.webContents.send(IPC.event.mainToRenderer.chatTransparencyDecrease)
      } catch { }
    },
    onNotesToggle: () => {
      try {
        sendProgress('Notes shortcut triggered')
        toggleNotesFloatWindow()
      } catch (e: any) {
        sendProgress(`Error in notes shortcut handler: ${e?.message ?? String(e)}`)
      }
    },
    onDictationToggle: () => toggleDictation('global'),
    onAIModeToggle: toggleAIMode
  })

  // Register all keyboard shortcuts
  const shortcutsOk = keyboardShortcuts.registerShortcuts()
  if (shortcutsOk) {
    sendProgress('✓ All keyboard shortcuts registered')
  } else {
    sendProgress('✗ Some keyboard shortcuts failed to register')
  }

  // Setup hold shortcuts handlers
  holdShortcuts.setHandlers({
    onDictationHoldStart: () => startDictation('global'),
    onDictationHoldStop: stopDictation,
    onAIModeHoldStart: startAIMode,
    onAIModeHoldStop: stopAIMode
  })

  // Start hold shortcuts listener (only if accessibility permissions are granted on macOS)
  // On macOS, uiohook-napi crashes if accessibility permissions are not granted
  let holdShortcutsOk = false
  if (process.platform !== 'darwin') {
    holdShortcutsOk = holdShortcuts.startListening()
    if (holdShortcutsOk) sendProgress('✓ Hold shortcuts listener started')
    else sendProgress('✗ Failed to start hold shortcuts listener')
  } else {
    const onboardingComplete = (prefs as any).permissionsOnboardingCompleted === true
    const inputMonitoringApproved = holdShortcuts.isActive() || (prefs as any).inputMonitoringApproved === true
    const accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(false)

    if (onboardingComplete && inputMonitoringApproved && accessibilityTrusted) {
      holdShortcutsOk = holdShortcuts.startListening()
      if (holdShortcutsOk) {
        sendProgress('✓ Hold shortcuts listener started')
      } else {
        sendProgress('✗ Hold shortcuts listener needs repair or restart')
      }
    } else {
      sendProgress('⚠ Hold shortcuts disabled until permissions setup is completed')
    }
  }

  void reverifyManualPermissions(true)

  // Re-check accessibility on focus and reinitialize hold shortcuts if they became available
  let lastAccessibilityRecheckAt = 0
  const maybeReinitializeHoldShortcuts = () => {
    if (process.platform !== 'darwin') return

    const onboardingComplete = (prefs as any).permissionsOnboardingCompleted === true
    const inputMonitoringApproved = (prefs as any).inputMonitoringApproved === true
    if (!onboardingComplete || !inputMonitoringApproved) return

    const now = Date.now()
    if (now - lastAccessibilityRecheckAt < 5000) return
    lastAccessibilityRecheckAt = now

    try {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false)
      if (!trusted) return
      if (holdShortcuts.isActive()) return

      const ok = holdShortcuts.reinitialize()
      if (ok) {
        sendProgress('✓ Hold shortcuts activated')
      } else {
        sendProgress('✗ Hold shortcuts still inactive (repair or restart may be required)')
      }
    } catch (err) {
      console.error('Failed to reinitialize hold shortcuts on focus:', err)
    }
  }

  app.on('browser-window-focus', () => {
    maybeReinitializeHoldShortcuts()
    void reverifyManualPermissions()
  })

  // Pre-warm HUD window for instant toggle response
  try {
    const width = 220, height = 38
    const { x, y } = getHudPosition(width, height)
    hudWindow = new BrowserWindow({
      width, height, x, y,
      frame: false, transparent: true, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
      backgroundColor: '#00000000', show: false, // Hidden until first toggle   
      icon: APP_ICON_PATH,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    configureHudWindow(hudWindow)
    // Pre-load content so it's ready
    hudWindow.loadFile(path.join(__dirname, '..', 'hud.html'), { query: { vis: '0', a: '0', k: 'start', mode: 'dictation' } })
  } catch { }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    showMainWindow()
    maybeReinitializeHoldShortcuts()
  })

  // Dictation state tracking
  let dictationCooldown = 0
  let aiModeCooldown = 0

  function startDictation(origin: 'global' | 'chat' = 'global') {
    if (dictationActive || aiModeActive) return
    if (!isTaskConfigured('transcription')) {
      showHudNotice('Set up transcription in Settings → AI Providers', 'dictation')
      return
    }

    dictationOrigin = origin
    chatInitiatedDictation = origin === 'chat'
    dictationActive = true
    dictationStartTime = Date.now() // Track start time
    micSuppressUntilInactive = true
    handsFreeActive = true

    // Send to renderer FIRST to start recording immediately
    try { mainWindow?.webContents.send(IPC.event.mainToRenderer.dictationStart) } catch { }
    // Also notify chat window for button state update
    try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationStart) } catch { }

    showDictationHUD('dictation')
  }

  function stopDictation() {
    if (!dictationActive) return
    dictationActive = false

    // Check if dictation was < 2 seconds, show "Dictation too short" message
    const duration = Date.now() - dictationStartTime
    if (duration < 2000) {
      // Too short, show "Dictation too short" message for 2 seconds
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: false, kind: 'too-short', mode: 'dictation' })
        if (hudWindow.showInactive) hudWindow.showInactive()
        else hudWindow.show()
        sendProgress('Dictation too short (<2s)')
      }

      // Hide HUD after 2 seconds
      setTimeout(() => {
        if (hudWindow && !hudWindow.isDestroyed()) {
          hudWindow.hide()
        }
      }, 2000)

      keepHudUntilPaste = false
      handsFreeActive = false
      try { mainWindow?.webContents.send(IPC.event.mainToRenderer.dictationStop) } catch { }
      // Notify chat window that dictation is complete (with empty text since too short)
      try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '') } catch { }
      setTimeout(() => { micSuppressUntilInactive = false }, 300)
      return
    }

    // Normal processing for >= 2 second sessions
    // Keep HUD visible until paste completes
    keepHudUntilPaste = true

    // Instant HUD transition to stop state via IPC
    if (hudWindow && !hudWindow.isDestroyed()) {
      const now = Date.now()
      const playAudio = now - lastHudAudioAt > 250
      if (playAudio) lastHudAudioAt = now
      hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: playAudio, kind: 'stop', mode: 'dictation' })
      if (hudWindow.showInactive) hudWindow.showInactive()
      else hudWindow.show()
    }

    // Auto-close HUD after 10 seconds if no paste occurs (prevents indefinite "Processing..." bug)
    if (hudCloseTimeout) clearTimeout(hudCloseTimeout)
    hudCloseTimeout = setTimeout(() => {
      keepHudUntilPaste = false
      handsFreeActive = false
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.hide()
      }
      try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '') } catch { }
      hudCloseTimeout = null
    }, 10000)

    try { mainWindow?.webContents.send(IPC.event.mainToRenderer.dictationStop) } catch { }
    // Notify chat window that dictation stopped (processing starts)
    try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationStop) } catch { }
    setTimeout(() => { micSuppressUntilInactive = false }, 300)
  }

  function toggleDictation(origin: 'global' | 'chat' = 'global') {
    const now = Date.now()
    if (now < dictationCooldown) return
    dictationCooldown = now + 500 // 500ms cooldown to prevent spam/double-triggers

    if (dictationActive) {
      stopDictation()
    } else {
      startDictation(origin)
    }
  }

  async function startAIMode() {
    if (aiModeActive || dictationActive) return
    if (!isTaskConfigured('transcription') || !isTaskConfigured('chat')) {
      showHudNotice('Set up chat and transcription in Settings → AI Providers', 'ai')
      return
    }

    aiModeActive = true
    aiModeStartTime = Date.now() // Track start time
    micSuppressUntilInactive = true
    handsFreeActive = true

    // Capture screenshot when AI mode starts for context-aware processing
    // Await to ensure screenshot is captured before recording starts
    aiModeScreenshotId = null
    try {
      console.log('[AI Mode] Attempting screenshot capture...')
      const screenshot = await screenshotHelper.captureScreenshot()
      if (screenshot) {
        aiModeScreenshotId = screenshot.id
        console.log(`[AI Mode] Captured screenshot: ${screenshot.id}`)
        sendProgress(`[AI Mode] Captured screenshot: ${screenshot.id}`)
      } else {
        console.log('[AI Mode] Screenshot capture returned null - check screen recording permissions')
        sendProgress(`[AI Mode] Screenshot capture returned null - check screen recording permissions`)
      }
    } catch (err: any) {
      console.log(`[AI Mode] Screenshot capture failed: ${err?.message ?? 'Unknown error'}`)
      sendProgress(`[AI Mode] Screenshot capture failed: ${err?.message ?? 'Unknown error'}`)
    }

    // Send to renderer FIRST to start recording immediately
    try { mainWindow?.webContents.send(IPC.event.mainToRenderer.aimodeStart) } catch { }
    // Also notify chat window for button state update
    try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationStart) } catch { }
    showDictationHUD('ai')
  }

  function stopAIMode() {
    if (!aiModeActive) return
    aiModeActive = false

    // Check if Agentic Dictation was < 2 seconds, show "Dictation too short" message
    const duration = Date.now() - aiModeStartTime
    if (duration < 2000) {
      // Too short, show "Dictation too short" message for 2 seconds
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: false, kind: 'too-short', mode: 'ai' })
        if (hudWindow.showInactive) hudWindow.showInactive()
        else hudWindow.show()
      }

      // Hide HUD after 2 seconds
      setTimeout(() => {
        if (hudWindow && !hudWindow.isDestroyed()) {
          hudWindow.hide()
        }
      }, 2000)

      keepHudUntilPaste = false
      handsFreeActive = false
      try { mainWindow?.webContents.send(IPC.event.mainToRenderer.aimodeStop) } catch { }
      try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '') } catch { }
      setTimeout(() => { micSuppressUntilInactive = false }, 300)
      return
    }

    // Normal processing for >= 2 second sessions
    // Keep HUD visible until paste completes
    keepHudUntilPaste = true

    // Instant HUD transition to stop state via IPC
    if (hudWindow && !hudWindow.isDestroyed()) {
      const now = Date.now()
      const playAudio = now - lastHudAudioAt > 250
      if (playAudio) lastHudAudioAt = now
      hudWindow.webContents.send(IPC.event.mainToRenderer.hudUpdate, { vis: true, audio: playAudio, kind: 'stop', mode: 'ai' })
      if (hudWindow.showInactive) hudWindow.showInactive()
      else hudWindow.show()
    }

    // Auto-close HUD after 60 seconds if no paste occurs (prevents indefinite "Processing..." bug)
    // AI mode needs longer timeout due to Groq transcription + OpenRouter AI formatting
    if (hudCloseTimeout) clearTimeout(hudCloseTimeout)
    hudCloseTimeout = setTimeout(() => {
      sendProgress('[AI Mode] HUD timeout reached (60s) - closing')
      keepHudUntilPaste = false
      handsFreeActive = false
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.hide()
      }
      try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationComplete, '') } catch { }
      hudCloseTimeout = null
    }, 60000)

    try { mainWindow?.webContents.send(IPC.event.mainToRenderer.aimodeStop) } catch { }
    // Notify chat window that dictation stopped (processing starts)
    try { chatWindow?.webContents.send(IPC.event.mainToRenderer.chatDictationStop) } catch { }
    setTimeout(() => { micSuppressUntilInactive = false }, 300)
  }

  function toggleAIMode() {
    const now = Date.now()
    if (now < aiModeCooldown) return
    aiModeCooldown = now + 500 // 500ms cooldown to prevent spam/double-triggers

    if (aiModeActive) {
      stopAIMode()
    } else {
      startAIMode()
    }
  }

  registerDictationIpcHandlers({
    getPrefs: () => prefs,
    savePrefs,
    sendProgress,
    isTrustedRendererEvent,
    blockedInvokeResult,
    getMainWindow: () => mainWindow,
    getChatWindow: () => chatWindow,
    closePromptWindow: () => {
      if (promptWindow && !promptWindow.isDestroyed()) {
        promptWindow.close()
      }
    },
    ensureNotesFloatWindowVisible: () => {
      if (!notesFloatWindow || notesFloatWindow.isDestroyed()) {
        createNotesFloatWindow()
      } else if (!notesFloatWindowVisible) {
        toggleNotesFloatWindow()
      }
    },
    getHudWindow: () => hudWindow,
    hideHudWindow: hideDictationHUD,
    getHudCloseTimeout: () => hudCloseTimeout,
    setHudCloseTimeout: (timer) => {
      hudCloseTimeout = timer
    },
    getDictationOrigin: () => dictationOrigin,
    setDictationOrigin: (value) => {
      dictationOrigin = value
    },
    getDictationActive: () => dictationActive,
    setDictationActive: (value) => {
      dictationActive = value
    },
    setAiModeActive: (value) => {
      aiModeActive = value
    },
    setHandsFreeActive: (value) => {
      handsFreeActive = value
    },
    setKeepHudUntilPaste: (value) => {
      keepHudUntilPaste = value
    },
    setChatInitiatedDictation: (value) => {
      chatInitiatedDictation = value
    },
    setMicSuppressUntilInactive: (value) => {
      micSuppressUntilInactive = value
    },
    setCurrentMicSessionDismissed: (value) => {
      currentMicSessionDismissed = value
    },
    toggleDictation
  })

})

app.on('will-quit', () => {
  updaterController.stopAutoUpdateChecks()
  try { globalShortcut.unregisterAll() } catch { }
  try { keyboardShortcuts.unregisterShortcuts() } catch { }
  try { holdShortcuts.stopListening() } catch { }
  try { micWatcher?.stop(); micWatcher = null } catch { }
  try { stopMicWatcher() } catch { }

})

// Sync to cloud before quitting (best-effort with timeout)
let isQuitting = false
let notesFlushedBeforeQuit = false
app.on('before-quit', (event) => {
  isQuitting = true
  if (notesFlushedBeforeQuit) return
  event.preventDefault()
  void flushNoteEdits([mainWindow, notesFloatWindow]).finally(() => {
    notesFlushedBeforeQuit = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

registerControlIpcHandlers({
  setRecordingState: (recording) => {
    isRecording = recording
  },
  setAudioMode: (mode) => {
    currentAudioMode = mode
  },
  updateTrayMenu,
  sendProgress,
  isTrustedRendererEvent,
  deleteTempRecordingById: async (recordingId) => {
    const resource = tempRecordingStore.release(recordingId)
    if (!resource) return false

    const tempRecordingsDir = path.join(app.getPath('temp'), 'notto')
    if (!isAllowedTempRecordingPath(resource.filePath, tempRecordingsDir)) {
      return false
    }

    if (resource.filePath && fs.existsSync(resource.filePath)) {
      await safeUnlink(resource.filePath)
    }
    return true
  }
})

registerPermissionsIpcHandlers({
  getPrefs: () => prefs,
  savePrefs,
  probeScreenRecording,
  verifyAutomationPermissionNow,
  reverifyManualPermissions,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult
})

registerSettingsIpcHandlers({
  getPrefs: () => prefs,
  savePrefs,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult,
  getMainWindow: () => mainWindow,
  getChatWindow: () => chatWindow,
  getNotesFloatWindow: () => notesFloatWindow,
  applyChatStealthMode,
  applyNotesStealthMode,
  toggleChatClickThrough,
  updateMicWatcherIgnoredApps: (apps) => {
    try { micWatcher?.updateIgnoredApps?.(apps) } catch { }
    try { micWatcher?.updateCustomApps?.(apps) } catch { }
  },
  playCueTest: async () => {
    showCue('start')
    await new Promise((resolve) => setTimeout(resolve, 350))
    showCue('stop')
  }
})

registerDataIpcHandlers({
  isTrustedRendererEvent,
  blockedInvokeResult
})

registerAiIpcHandlers({
  getAiSettings: () => prefs.ai,
  setAiSettings: (settings) => {
    prefs.ai = settings
    savePrefs()
  },
  isTrustedRendererEvent,
  blockedInvokeResult
})

registerAudioIpcHandlers({
  getPrefs: () => prefs,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult,
  tempRecordingStore,
  isRecordingPaused: () => isRecordingPaused,
  getAiModeScreenshotId: () => aiModeScreenshotId,
  clearAiModeScreenshotId: () => {
    aiModeScreenshotId = null
  },
  getMainWindow: () => mainWindow
})

function isNotesIpcAllowed(evt: any): boolean {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const senderWin = BrowserWindow.fromWebContents(evt.sender)
    return !!senderWin && senderWin.id === mainWindow.id
  } catch {
    return false
  }
}

registerNotesIpcHandlers({
  repo: notesRepository,
  getPrefs: () => prefs,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult,
  isNotesIpcAllowed,
  getMainWindow: () => mainWindow,
  getNotesFloatWindow: () => notesFloatWindow,
  getHudWindow: () => hudWindow,
  ensureNotesFloatWindowVisible: () => {
    if (!notesFloatWindow || notesFloatWindow.isDestroyed()) {
      createNotesFloatWindow()
    } else if (!notesFloatWindowVisible) {
      toggleNotesFloatWindow()
    }
  },
  hideNotesOverlayWindow,
  getIsMeetingActive: () => isMeetingActive,
  setIsMeetingActive: (value) => {
    isMeetingActive = value
  },
  getIsRecordingPaused: () => isRecordingPaused,
  setIsRecordingPaused: (value) => {
    isRecordingPaused = value
  },
  getSilenceDetectionTimer: () => silenceDetectionTimer,
  setSilenceDetectionTimer: (timer) => {
    silenceDetectionTimer = timer
  },
  getLastAudioActivity: () => lastAudioActivity,
  setLastAudioActivity: (value) => {
    lastAudioActivity = value
  },
  getPersonalNotesContent: () => personalNotesContent,
  setPersonalNotesContent: (value) => {
    personalNotesContent = value
  },
  getStandaloneNoteId: () => standaloneNoteId,
  setStandaloneNoteId: (value) => {
    standaloneNoteId = value
  },
  setLastTranscriptText: (value) => {
    lastTranscriptText = value
  },
  setLastSummaryText: (value) => {
    lastSummaryText = value
  }
})

registerChatIpcHandlers({
  notesRepository,
  getPrefs: () => prefs,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult,
  getChatWindow: () => chatWindow,
  hideChatOverlayWindow,
  toggleChatWindow,
  resizeChatWindow: (height) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      const [width] = chatWindow.getSize()
      const { x, y } = chatWindow.getBounds()
      const nextBounds = clampBoundsToDisplay({
        x,
        y,
        width,
        height: Math.max(50, Math.min(height, 600))
      }, { minWidth: 360, minHeight: 50, maxWidth: 900, maxHeight: 600, margin: 12 })
      chatWindow.setBounds(nextBounds, false)
      persistChatWindowBounds(nextBounds)
    }
  },
  getLastTranscriptText: () => lastTranscriptText,
  getActiveChatAbortController: () => activeChatAbortController,
  setActiveChatAbortController: (controller) => {
    activeChatAbortController = controller
  }
})

registerTrainerIpcHandlers({
  notesRepository,
  sendProgress,
  isTrustedRendererEvent,
  blockedInvokeResult
})

let personalNotesContent = ''
let standaloneNoteId: string | null = null // ID of auto-saved note when no meeting active

// Cross-platform mic watcher (Windows, macOS, Linux)
// Uses platform-specific implementations from ./main/MicWatcher module
let micWatcher: IMicWatcher | null = null

/**
 * Handle mic state changes from the cross-platform watcher
 * This callback is invoked when mic goes active or inactive
 */
function handleMicStateChange(active: boolean): void {
  const was = lastMicActive

  if (active) {
    if (!was) {
      lastMicActive = true
      try { sendProgress('Mic watcher: ACTIVE') } catch { }
      // Suppress meeting prompt if any dictation-related flag is set
      if (shouldShowMicPrompt({
        micSuppressUntilInactive,
        dictationActive,
        aiModeActive,
        chatInitiatedDictation,
        currentMicSessionDismissed,
        isMeetingActive
      }) && !isWithinResumeGracePeriod()) {
        showPromptWindow()
        micSuppressUntilInactive = true
      }
    }
  } else {
    if (was) {
      lastMicActive = false
      try { sendProgress('Mic watcher: INACTIVE') } catch { }
      micSuppressUntilInactive = false
      currentMicSessionDismissed = false // Reset dismiss flag for new session

      // Auto-stop recording if meeting is active
      if (isMeetingActive) {
        sendProgress('Meeting ended - auto-stopping recording...')
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send(IPC.event.mainToRenderer.meetingAutoStop)
        }
      }

      // Do not hide HUD if we're in 'Processing until paste' state
      if (!dictationActive && !handsFreeActive && !keepHudUntilPaste) {
        try { hideDictationHUD() } catch { }
      }
    }
  }
}

function handleMicStatusChange(status: MicWatcherStatus): void {
  if (status.state === 'unknown') {
    sendProgress(`Mic watcher: UNKNOWN (${status.source}${status.details ? ` - ${status.details}` : ''})`)
    return
  }

  if (status.state === 'error') {
    sendProgress(`Mic watcher: ERROR (${status.source}${status.details ? ` - ${status.details}` : ''})`)
    return
  }

  handleMicStateChange(status.active)
}

function tryStartMicWatcher() {
  const helperName = process.platform === 'darwin'
    ? 'mac-mic-watcher'
    : process.platform === 'win32'
      ? 'win-mic-watcher.exe'
      : null
  if (helperName) {
    const resolution = describeMicWatcherHelperResolution(helperName)
    const helperStatus = resolution.resolvedPath
      ? `resolved ${path.basename(resolution.resolvedPath)}`
      : `missing (${resolution.candidates.length} candidate paths checked)`
    sendProgress(`Mic watcher helper self-test: ${helperStatus}`)
  }

  micWatcher = createMicWatcher({
    events: {
      onStatusChange: handleMicStatusChange,
      onError: (err) => sendProgress(`Mic watcher: ${err.message}`)
    },
    ignoredMicApps: prefs.ignoredMicApps || []
  })
  micWatcher.start()
  sendProgress(`Mic watcher started (platform: ${process.platform})`)
}

function stopMicWatcher() {
  if (micWatcher) {
    micWatcher.stop()
    micWatcher = null
  }
}

function showPromptWindow() {
  if (!mainWindow) return
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow.focus(); return
  }
  const width = 360
  const height = 140
  const disp = screen.getPrimaryDisplay()
  const work = disp.workArea
  const x = Math.floor(work.x + (work.width - width) / 2)
  const y = Math.max(work.y + 12, work.y) // slight offset from top

  promptWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    movable: true,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Show only when ready to prevent flickering
  promptWindow.once('ready-to-show', () => {
    if (promptWindow && !promptWindow.isDestroyed()) {
      promptWindow.show()
    }
  })
  promptWindow.setAlwaysOnTop(true, 'screen-saver')
  promptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  promptWindow.loadFile(path.join(__dirname, '..', 'prompt.html')).catch(() => { })

  promptWindow.on('closed', () => { promptWindow = null })
}

// Cue overlay (bottom-center, subtle). Loads toast.html with query params
function showCue(kind: 'start' | 'stop') {
  try {
    if (!prefs.cueVisual && !prefs.cueAudio) return

    // Close any existing cue to prevent stacking/duplicates
    try { if (cueWindow && !cueWindow.isDestroyed()) cueWindow.close() } catch { }
    cueWindow = null

    const width = 240
    const height = 50
    const disp = screen.getPrimaryDisplay()
    const work = disp.workArea
    const x = Math.floor(work.x + (work.width - width) / 2)
    const y = work.y + work.height - height - 40 // Position at bottom with 40px offset
    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true, // ensure no blank rectangle when visual is disabled
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true
      }
    })
    const vol = String(Math.max(0, Math.min(1, prefs.cueVolume ?? 0.4)))
    const audio = prefs.cueAudio ? '1' : '0'
    const visual = prefs.cueVisual ? '1' : '0'
    // Use HUD style for stop (smaller gray pill), toast for start
    const file = kind === 'stop' ? 'hud.html' : 'toast.html'
    win.loadFile(path.join(__dirname, '..', file), { query: { k: kind, v: vol, a: audio, vis: visual } }).catch(() => { })
    // Keep cue reliably on top across desktops and fullscreen
    try { win.setAlwaysOnTop(true, 'screen-saver'); win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch { }
    setTimeout(() => { try { if (!win.isDestroyed()) win.close() } catch { } }, 1600)
    cueWindow = win
  } catch { }
}
