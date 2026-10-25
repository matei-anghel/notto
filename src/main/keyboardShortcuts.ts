import { globalShortcut, BrowserWindow, screen } from 'electron'
import { screenshotHelper } from './ScreenshotHelper'
import { IPC } from '../shared/ipcChannels'
import { holdShortcuts } from './holdShortcuts'

export interface KeyboardShortcutsConfig {
  // Screenshot shortcuts
  screenshotCapture: string

  // Chat window shortcuts
  chatToggle: string
  chatMoveUp: string
  chatMoveDown: string
  chatMoveLeft: string
  chatMoveRight: string

  // Chat action shortcuts
  chatSend: string
  chatNewChat: string

  // Chat transparency shortcuts
  chatTransparencyIncrease: string
  chatTransparencyDecrease: string

  // Notes window shortcuts
  notesToggle: string

  // Dictation shortcuts
  dictationToggle: string
  aiModeToggle: string

  // Hold shortcuts
  dictationHold: string
  aiModeHold: string
}

const isMac = process.platform === 'darwin'

const defaultConfig: KeyboardShortcutsConfig = {
  // Screenshot shortcuts
  screenshotCapture: isMac ? 'Command+Control+S' : 'CommandOrControl+Alt+S',

  // Chat window shortcuts
  chatToggle: isMac ? 'Option+Space' : 'CommandOrControl+Space', // Changed Alt to Option for clarity on Mac
  chatMoveUp: isMac ? 'Command+Control+Up' : 'CommandOrControl+Alt+Up',
  chatMoveDown: isMac ? 'Command+Control+Down' : 'CommandOrControl+Alt+Down',
  chatMoveLeft: isMac ? 'Command+Control+Left' : 'CommandOrControl+Alt+Left',
  chatMoveRight: isMac ? 'Command+Control+Right' : 'CommandOrControl+Alt+Right',

  // Chat action shortcuts
  chatSend: isMac ? 'Command+Control+P' : 'CommandOrControl+Alt+P',
  chatNewChat: isMac ? 'Command+Control+N' : 'CommandOrControl+Alt+N',

  // Chat transparency shortcuts
  // Use '=' instead of 'Plus' to avoid parsing ambiguity with double '+'
  chatTransparencyIncrease: isMac ? 'Command+Control+=' : 'CommandOrControl+Alt+=',
  chatTransparencyDecrease: isMac ? 'Command+Control+-' : 'CommandOrControl+Alt+-',

  // Notes window shortcuts
  notesToggle: isMac ? 'Command+Control+Shift+N' : 'CommandOrControl+Alt+Shift+N',

  // Dictation shortcuts
  dictationToggle: isMac ? 'Command+Shift+D' : 'CommandOrControl+Shift+D',
  aiModeToggle: isMac ? 'Command+Shift+A' : 'CommandOrControl+Shift+A',

  // Hold shortcuts (handled by uiohook, using specific modifier names)
  dictationHold: isMac ? 'Command+Option+D' : 'CommandOrControl+Alt+D',
  aiModeHold: isMac ? 'Control+Option+A' : 'CommandOrControl+Alt+A'
}

export type ShortcutHandlers = {
  onScreenshotCapture?: () => void
  onChatToggle?: () => void
  onChatMove?: (deltaX: number, deltaY: number) => void
  onChatSend?: () => void
  onChatNewChat?: () => void
  onChatTransparencyIncrease?: () => void
  onChatTransparencyDecrease?: () => void
  onNotesToggle?: () => void
  onDictationToggle?: () => void
  onAIModeToggle?: () => void
}

function normalizeAccelerator(accelerator: string | undefined): string {
  if (!accelerator || !accelerator.trim() || accelerator.trim().toLowerCase() === 'unbound') return ''
  const aliases: Record<string, string> = {
    COMMANDORCONTROL: isMac ? 'CMD' : 'CTRL', CMDORCTRL: isMac ? 'CMD' : 'CTRL',
    CONTROL: 'CTRL', CTRL: 'CTRL', COMMAND: 'CMD', CMD: 'CMD', META: 'CMD', SUPER: 'CMD',
    OPTION: 'ALT', ALT: 'ALT', ALTGR: 'ALTGR', SHIFT: 'SHIFT'
  }
  const parts = accelerator.split('+').map(part => part.trim().toUpperCase()).filter(Boolean)
  const modifiers = parts.filter(part => aliases[part]).map(part => aliases[part]).sort()
  const keys = parts.filter(part => !aliases[part])
  return [...modifiers, ...keys].join('+')
}

export class KeyboardShortcutsManager {
  private config: KeyboardShortcutsConfig
  private handlers: ShortcutHandlers
  private disabledActions: Set<string> = new Set()
  private registered = false
  private lastFailedActions: string[] = []
  private chatMoveStepSize = 20

  // Rate-limiting: prevent rapid re-triggering of chat toggle (fixes macOS 26 spacebar issue)
  private lastChatToggleTime = 0
  private static CHAT_TOGGLE_COOLDOWN_MS = 150

  constructor(config?: Partial<KeyboardShortcutsConfig>, handlers?: ShortcutHandlers) {
    this.config = { ...defaultConfig, ...config }
    this.handlers = handlers || {}
  }

  setHandlers(handlers: ShortcutHandlers): void {
    this.handlers = { ...this.handlers, ...handlers }
  }

  setDisabledActions(actions: string[]): void {
    const wasRegistered = this.registered
    if (wasRegistered) {
      this.unregisterShortcuts()
    }
    this.disabledActions = new Set(actions)
    if (wasRegistered) {
      this.registerShortcuts()
    }
  }

  registerShortcuts(): boolean {
    if (this.registered) {
      console.warn('Shortcuts already registered')
      return false
    }

    try {
      const results: Record<string, boolean> = {}

      // Helper to safely register (handles invalid shortcuts gracefully)
      const safeRegister = (key: string, handler: () => void, actionName: keyof KeyboardShortcutsConfig) => {
        try {
          if (this.disabledActions.has(actionName)) {
            // Action is disabled, skip registration but return "success" as it's intended
            return true
          }
          if (!key || (!key.includes('+') && !key.trim())) return false
          // Check for modifier-only shortcuts (invalid for globalShortcut)
          const parts = key.split('+').map(p => p.trim())
          const modifiers = ['Command', 'Control', 'CommandOrControl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']
          const hasKey = parts.some(p => !modifiers.includes(p))
          if (!hasKey) {
            console.warn(`Skipping invalid shortcut (modifier-only): ${key}`)
            return false
          }
          return globalShortcut.register(key, handler)
        } catch (e) {
          console.warn(`Failed to register shortcut ${key}:`, e)
          return false
        }
      }

      // Screenshot shortcuts
      results.screenshotCapture = safeRegister(
        this.config.screenshotCapture,
        () => this.handleScreenshotCapture(),
        'screenshotCapture'
      )

      // Chat window shortcuts
      results.chatToggle = safeRegister(
        this.config.chatToggle,
        () => this.handleChatToggleWithSafeguards(),
        'chatToggle'
      )
      results.chatMoveUp = safeRegister(
        this.config.chatMoveUp,
        () => this.handlers.onChatMove?.(0, -this.chatMoveStepSize),
        'chatMoveUp'
      )
      results.chatMoveDown = safeRegister(
        this.config.chatMoveDown,
        () => this.handlers.onChatMove?.(0, this.chatMoveStepSize),
        'chatMoveDown'
      )
      results.chatMoveLeft = safeRegister(
        this.config.chatMoveLeft,
        () => this.handlers.onChatMove?.(-this.chatMoveStepSize, 0),
        'chatMoveLeft'
      )
      results.chatMoveRight = safeRegister(
        this.config.chatMoveRight,
        () => this.handlers.onChatMove?.(this.chatMoveStepSize, 0),
        'chatMoveRight'
      )

      // Chat action shortcuts
      results.chatSend = safeRegister(
        this.config.chatSend,
        () => this.handlers.onChatSend?.(),
        'chatSend'
      )
      results.chatNewChat = safeRegister(
        this.config.chatNewChat,
        () => this.handlers.onChatNewChat?.(),
        'chatNewChat'
      )

      // Chat transparency shortcuts
      results.chatTransparencyIncrease = safeRegister(
        this.config.chatTransparencyIncrease,
        () => this.handlers.onChatTransparencyIncrease?.(),
        'chatTransparencyIncrease'
      )
      results.chatTransparencyDecrease = safeRegister(
        this.config.chatTransparencyDecrease,
        () => this.handlers.onChatTransparencyDecrease?.(),
        'chatTransparencyDecrease'
      )

      // Notes window shortcuts
      results.notesToggle = safeRegister(
        this.config.notesToggle,
        () => this.handlers.onNotesToggle?.(),
        'notesToggle'
      )

      // Dictation shortcuts
      results.dictationToggle = safeRegister(
        this.config.dictationToggle,
        () => this.handlers.onDictationToggle?.(),
        'dictationToggle'
      )
      results.aiModeToggle = safeRegister(
        this.config.aiModeToggle,
        () => this.handlers.onAIModeToggle?.(),
        'aiModeToggle'
      )

      const failedKeys = Object.entries(results).filter(([_, success]) => !success).map(([key]) => key)

      if (failedKeys.length > 0) {
        console.warn('Some shortcuts failed to register:', failedKeys)
      }

      this.lastFailedActions = failedKeys
      this.registered = true
      return true
    } catch (err) {
      console.error('Failed to register shortcuts:', err)
      return false
    }
  }

  unregisterShortcuts() {
    // Unregister all shortcuts we know about
    const shortcuts = Object.values(this.config)

    shortcuts.forEach(key => {
      try {
        if (key && typeof key === 'string' && key.trim() && globalShortcut.isRegistered(key)) {
          globalShortcut.unregister(key)
        }
      } catch (err) {
        // Ignore errors from invalid shortcuts (e.g. modifier-only strings from old configs)
        console.warn(`Failed to safely unregister shortcut '${key}':`, err)
      }
    })
    this.registered = false
  }

  private async handleScreenshotCapture(): Promise<void> {
    if (this.handlers.onScreenshotCapture) {
      this.handlers.onScreenshotCapture()
      return
    }

    try {
      const screenshot = await screenshotHelper.captureScreenshot()

      if (screenshot) {
        // Send notification to chat window
        const windows = BrowserWindow.getAllWindows()
        const chatWindow = windows.find((w: any) => {
          try {
            return w.webContents.getURL().includes('chat.html')
          } catch {
            return false
          }
        })

        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send(IPC.event.mainToRenderer.screenshotCaptured, screenshot)
        }
      } else {
        console.error('Screenshot capture failed')
      }
    } catch (err) {
      console.error('Error handling capture:', err)
    }
  }

  /** Actions whose accelerator the OS refused (usually already taken by another app). */
  getFailedActions(): string[] {
    return [...this.lastFailedActions]
  }

  /**
   * Find an action that would share its key combination with another action once `updates`
   * are applied. Two actions on one combo means only one of them can ever fire.
   */
  findConflict(updates: Partial<KeyboardShortcutsConfig>): { action: string; conflictsWith: string } | null {
    const merged = { ...this.config, ...updates } as Record<string, string>
    const updatedActions = Object.keys(updates)
    // Visit changed actions last so the conflict is reported against the action being changed.
    const order = [...Object.keys(merged).filter(action => !updatedActions.includes(action)), ...updatedActions]
    const seen = new Map<string, string>()
    for (const action of order) {
      const combo = normalizeAccelerator(merged[action])
      if (!combo) continue
      const other = seen.get(combo)
      if (other && other !== action) return { action, conflictsWith: other }
      seen.set(combo, action)
    }
    return null
  }

  updateConfig(config: Partial<KeyboardShortcutsConfig>): boolean {
    const wasRegistered = this.registered
    if (wasRegistered) {
      this.unregisterShortcuts()
    }

    this.config = { ...this.config, ...config }

    if (wasRegistered) {
      return this.registerShortcuts()
    }

    return true
  }

  resetToDefaults(): boolean {
    const wasRegistered = this.registered
    if (wasRegistered) {
      this.unregisterShortcuts()
    }

    this.config = { ...defaultConfig }

    if (wasRegistered) {
      return this.registerShortcuts()
    }

    return true
  }

  getConfig(): KeyboardShortcutsConfig {
    return { ...this.config }
  }

  isRegistered(): boolean {
    return this.registered
  }

  setChatMoveStepSize(size: number): void {
    this.chatMoveStepSize = Math.max(1, Math.min(100, size))
  }

  /**
   * Handle chat toggle with safeguards to prevent spurious triggers on macOS 26.
   * Verifies the modifier key (Option on macOS, Ctrl on Windows) is actually pressed
   * and implements rate-limiting to prevent rapid re-triggering.
   */
  private handleChatToggleWithSafeguards(): void {
    const now = Date.now()
    const isMac = process.platform === 'darwin'

    // Rate-limiting: prevent rapid re-triggering
    if (now - this.lastChatToggleTime < KeyboardShortcutsManager.CHAT_TOGGLE_COOLDOWN_MS) {
      console.log('Chat toggle rate-limited, ignoring')
      return
    }

    // Verify modifier key state via uiohook (if available)
    // WORKAROUND: On macOS 26, globalShortcut.register sometimes misfires for 'Option+Space',
    // triggering when only 'Space' is pressed. This check verifies the physical key state
    // to ensure the modifier is actually held down, preventing accidental triggers.
    // macOS only: on Windows the hook gets no key events while an elevated (admin) window has
    // focus, so this check would silently swallow a genuine Ctrl+Space there.
    if (isMac && holdShortcuts.isActive()) {
      const modifiers = holdShortcuts.getActiveModifiers()
      const requiredModifier = isMac ? 'alt' : 'ctrl'

      if (!modifiers[requiredModifier]) {
        console.warn(`Chat toggle fired without ${requiredModifier} modifier - ignoring spurious trigger (System Compatibility Safeguard)`)
        return
      }
    }

    this.lastChatToggleTime = now
    this.handlers.onChatToggle?.()
  }
}

export const keyboardShortcuts = new KeyboardShortcutsManager()
