import type { UiohookKeyboardEvent } from 'uiohook-napi'

// Keycode constants from libuiohook (incomplete map, covers standard keys)
const KEYCODE_MAP: Record<string, number> = {
  // Numbers
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  // Alphabet
  'A': 30, 'B': 48, 'C': 46, 'D': 32, 'E': 18, 'F': 33, 'G': 34, 'H': 35, 'I': 23, 'J': 36,
  'K': 37, 'L': 38, 'M': 50, 'N': 49, 'O': 24, 'P': 25, 'Q': 16, 'R': 19, 'S': 31, 'T': 20,
  'U': 22, 'V': 47, 'W': 17, 'X': 45, 'Y': 21, 'Z': 44,
  // Symbols
  'SEMICOLON': 39, 'QUOTE': 40, 'COMMA': 51, 'PERIOD': 52, 'SLASH': 53, 'BACKSLASH': 43,
  'LBRACKET': 26, 'RBRACKET': 27, 'MINUS': 12, 'EQUALS': 13, 'GRAVE': 41,
  // Functional
  'SPACE': 57, 'TAB': 15, 'ENTER': 28, 'BACKSPACE': 14, 'ESCAPE': 1,
  // F-Keys
  'F1': 59, 'F2': 60, 'F3': 61, 'F4': 62, 'F5': 63, 'F6': 64, 'F7': 65, 'F8': 66, 'F9': 67, 'F10': 68, 'F11': 87, 'F12': 88
}

const MODIFIER_KEYCODES = new Set([
  29, 3613, // Ctrl
  42, 54,   // Shift
  56, 3640, // Alt
  3675, 3676, // Meta/Win
  58, 69, 70 // Caps, Num, Scroll locks (ignore these too usually? Let's treat them as non-blocking or just ignore them)
])

interface ShortcutDefinition {
  enabled: boolean
  modifiers: {
    ctrl: boolean
    meta: boolean
    alt: boolean
    shift: boolean
  }
  triggerKey?: number
}

function isModifierToken(part: string): boolean {
  return part === 'CTRL' || part === 'CONTROL' || part === 'COMMANDORCONTROL' ||
    part === 'META' || part === 'SUPER' || part === 'WIN' || part === 'COMMAND' ||
    part === 'ALT' || part === 'OPTION' || part === 'SHIFT'
}

function parseShortcut(shortcut: string): ShortcutDefinition {
  if (!shortcut || !shortcut.trim() || shortcut.trim().toLowerCase() === 'unbound') {
    return {
      enabled: false,
      modifiers: { ctrl: false, meta: false, alt: false, shift: false }
    }
  }

  const parts = shortcut.split('+').map(p => p.trim().toUpperCase())
  const hasNonModifierKey = parts.some(part => !isModifierToken(part))
  if (!hasNonModifierKey) {
    return {
      enabled: false,
      modifiers: { ctrl: false, meta: false, alt: false, shift: false }
    }
  }
  const def: ShortcutDefinition = {
    enabled: true,
    modifiers: { ctrl: false, meta: false, alt: false, shift: false }
  }

  for (const part of parts) {
    if (part === 'CTRL' || part === 'CONTROL' || part === 'COMMANDORCONTROL') def.modifiers.ctrl = true
    else if (part === 'META' || part === 'SUPER' || part === 'WIN' || part === 'COMMAND') def.modifiers.meta = true
    else if (part === 'ALT' || part === 'OPTION') def.modifiers.alt = true
    else if (part === 'SHIFT') def.modifiers.shift = true
    else {
      // Try to map key
      const kc = KEYCODE_MAP[part]
      if (kc) {
        def.triggerKey = kc
      }
    }
  }

  return def
}

export interface HoldShortcutHandlers {
  onDictationHoldStart?: () => void
  onDictationHoldStop?: () => void
  onAIModeHoldStart?: () => void
  onAIModeHoldStop?: () => void
}

export class HoldShortcutsManager {
  private uIOhook: any = null
  private handlers: HoldShortcutHandlers
  private isListening = false
  private initAttempted = false

  // State tracking for active shortcuts
  private isDictationHoldActive = false
  private isAIModeHoldActive = false
  private isPaused = false

  // Debouncing for transition (Ctrl+Win vs Ctrl+Win+X)
  private debounceTimer: NodeJS.Timeout | null = null
  private DEBOUNCE_MS = 30
  private verificationResolver: ((matched: boolean) => void) | null = null
  private verificationTimer: NodeJS.Timeout | null = null

  // Current shortcut definitions
  private dictationShortcut: ShortcutDefinition = parseShortcut(
    process.platform === 'darwin' ? 'Command+Option+D' : 'CommandOrControl+Alt+D'
  )

  private aiModeShortcut: ShortcutDefinition = parseShortcut(
    process.platform === 'darwin' ? 'Control+Option+A' : 'CommandOrControl+Alt+A'
  )

  // Track currently pressed keys
  private activeKeys = new Set<number>()
  private activeModifiers = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false
  }

  constructor(handlers?: HoldShortcutHandlers) {
    this.handlers = handlers || {}
    // Try to load uiohook-napi
    try {
      this.uIOhook = require('uiohook-napi').uIOhook
    } catch (err) {
      console.warn('uiohook-napi not available:', err)
      this.uIOhook = null
    }
  }

  setDisabledActions(actions: string[]): void {
    const disabledSet = new Set(actions)
    this.dictationShortcut.enabled = !disabledSet.has('dictationHold')
    this.aiModeShortcut.enabled = !disabledSet.has('aiModeHold')
  }

  setHandlers(handlers: HoldShortcutHandlers): void {
    this.handlers = { ...this.handlers, ...handlers }
  }

  setPaused(paused: boolean) {
    this.isPaused = paused
    if (paused) {
      // If pausing, cancel any pending starts and stop any active sessions force
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = null

      if (this.isDictationHoldActive) {
        this.isDictationHoldActive = false
        this.handlers.onDictationHoldStop?.()
      }
      if (this.isAIModeHoldActive) {
        this.isAIModeHoldActive = false
        this.handlers.onAIModeHoldStop?.()
      }
    }
  }

  setShortcuts(config: { dictationHold: string, aiModeHold: string }): void {
    const dictationEnabled = this.dictationShortcut.enabled
    const aiModeEnabled = this.aiModeShortcut.enabled

    if (config.dictationHold !== undefined) {
      this.dictationShortcut = parseShortcut(config.dictationHold)
      this.dictationShortcut.enabled = this.dictationShortcut.enabled && dictationEnabled
    }
    if (config.aiModeHold !== undefined) {
      this.aiModeShortcut = parseShortcut(config.aiModeHold)
      this.aiModeShortcut.enabled = this.aiModeShortcut.enabled && aiModeEnabled
    }
  }

  private checkAndUpdateStates(event: UiohookKeyboardEvent, isDown: boolean) {
    // Update active keys set
    if (isDown) {
      this.activeKeys.add(event.keycode)
    } else {
      this.activeKeys.delete(event.keycode)
    }

    // Update modifier key states from event properties if available
    if (event.ctrlKey !== undefined) {
      this.activeModifiers.ctrl = event.ctrlKey
    }
    if (event.metaKey !== undefined) {
      this.activeModifiers.meta = event.metaKey
    }
    if (event.altKey !== undefined) {
      this.activeModifiers.alt = event.altKey
    }
    if (event.shiftKey !== undefined) {
      this.activeModifiers.shift = event.shiftKey
    }
  }

  private isShortcutActive(def: ShortcutDefinition): boolean {
    if (!def.enabled) return false

    // Check modifiers match exactly
    if (def.modifiers.ctrl !== this.activeModifiers.ctrl) return false
    if (def.modifiers.meta !== this.activeModifiers.meta) return false
    if (def.modifiers.alt !== this.activeModifiers.alt) return false
    if (def.modifiers.shift !== this.activeModifiers.shift) return false

    // Filter out modifier keys from active keys to get "substantive" keys
    // We treat keys in MODIFIER_KEYCODES as "invisible" for the purpose of trigger checking
    // because uiohook often reports them as active keys too.
    const nonModifierKeys = Array.from(this.activeKeys).filter(k => !MODIFIER_KEYCODES.has(k))

    // Check trigger key if defined
    if (def.triggerKey !== undefined) {
      // Must contain the trigger key AND match strictness (no other keys)
      // e.g. activeKeys=[Ctrl, Win, X, Y] -> nonMod=[X, Y]. Def=[Ctrl, Win, X].
      // We want nonMod to ONLY contain X.
      return nonModifierKeys.length === 1 && nonModifierKeys[0] === def.triggerKey
    }

    // If no trigger key is defined (modifiers only, e.g. Ctrl+Win),
    // we require strictly NO other substantive keys pressed.
    return nonModifierKeys.length === 0
  }

  private evaluateShortcuts() {
    if (this.isPaused) return

    const dictationActive = this.isShortcutActive(this.dictationShortcut)
    const aiModeActive = this.isShortcutActive(this.aiModeShortcut)

    // START Logic (Debounced)
    // If we're not active yet, and a shortcut matches, we verify via debounce
    if ((dictationActive && !this.isDictationHoldActive) || (aiModeActive && !this.isAIModeHoldActive)) {
      if (!this.debounceTimer) {
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null
          // Re-check conditions after delay
          const nowDictationActive = this.isShortcutActive(this.dictationShortcut)
          const nowAiModeActive = this.isShortcutActive(this.aiModeShortcut)

          if (this.verificationResolver && (nowAiModeActive || nowDictationActive)) {
            const resolveVerification = this.verificationResolver
            this.verificationResolver = null
            if (this.verificationTimer) clearTimeout(this.verificationTimer)
            this.verificationTimer = null
            resolveVerification(true)
            return
          }

          // Prioritize AI Mode if both are somehow active (though strict check should prevent this usually)
          if (nowAiModeActive && !this.isAIModeHoldActive && !this.isDictationHoldActive) {
            this.isAIModeHoldActive = true
            this.handlers.onAIModeHoldStart?.()
          } else if (nowDictationActive && !this.isDictationHoldActive && !this.isAIModeHoldActive) {
            this.isDictationHoldActive = true
            this.handlers.onDictationHoldStart?.()
          }
        }, this.DEBOUNCE_MS)
      }
    } else {
      // If checks fail (maybe user released keys before timer fired), cancel timer
      // We check if "we are waiting for something but conditions don't match anymore"
      // But we need to be careful not to cancel if the *other* shortcut became active?
      // Actually, if simply checking immediate state:
      if (!dictationActive && !aiModeActive && this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
    }

    // STOP Logic (Immediate)
    // If active and condition fails, stop immediately
    if (this.isDictationHoldActive && !dictationActive) {
      this.isDictationHoldActive = false
      this.handlers.onDictationHoldStop?.()
    }

    if (this.isAIModeHoldActive && !aiModeActive) {
      this.isAIModeHoldActive = false
      this.handlers.onAIModeHoldStop?.()
    }
  }

  startListening(): boolean {
    if (this.isListening) {
      console.warn('Hold shortcuts already listening')
      return false
    }

    if (this.initAttempted) {
      console.warn('Hold shortcuts initialization already attempted')
      return false
    }

    if (!this.uIOhook) {
      console.error('uiohook-napi not available. Hold shortcuts will not work.')
      return false
    }

    this.initAttempted = true

    try {
      // Handle keydown events
      this.uIOhook.on('keydown', (event: UiohookKeyboardEvent) => {
        this.checkAndUpdateStates(event, true)
        this.evaluateShortcuts()
      })

      // Handle keyup events
      this.uIOhook.on('keyup', (event: UiohookKeyboardEvent) => {
        this.checkAndUpdateStates(event, false)
        this.evaluateShortcuts()
      })

      // Start the hook
      this.uIOhook.start()
      this.isListening = true
      return true
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      console.error('Failed to start hold shortcuts listener:', errorMsg)
      // Reset state on failure
      this.isListening = false
      return false
    }
  }

  stopListening(): void {
    if (!this.isListening) {
      return
    }

    try {
      if (this.uIOhook) {
        this.uIOhook.removeAllListeners()
        this.uIOhook.stop()
      }

      if (this.verificationTimer) {
        clearTimeout(this.verificationTimer)
        this.verificationTimer = null
      }
      if (this.verificationResolver) {
        this.verificationResolver(false)
        this.verificationResolver = null
      }

      this.isListening = false
      this.isDictationHoldActive = false
      this.isAIModeHoldActive = false
      this.activeKeys.clear()
      this.activeModifiers = {
        ctrl: false,
        meta: false,
        alt: false,
        shift: false
      }
    } catch (err) {
      console.error('Failed to stop hold shortcuts listener:', err)
    }
  }

  isActive(): boolean {
    return this.isListening
  }

  async verifyShortcutPress(timeoutMs = 5000): Promise<boolean> {
    if (!this.isListening) return false

    if (this.verificationResolver) {
      this.verificationResolver(false)
      this.verificationResolver = null
    }
    if (this.verificationTimer) {
      clearTimeout(this.verificationTimer)
      this.verificationTimer = null
    }

    return await new Promise<boolean>((resolve) => {
      this.verificationResolver = resolve
      this.verificationTimer = setTimeout(() => {
        const resolveVerification = this.verificationResolver
        this.verificationResolver = null
        this.verificationTimer = null
        resolveVerification?.(false)
      }, timeoutMs)
    })
  }

  /**
   * Reinitialize the hold shortcuts listener.
   * This is used when accessibility permissions are granted after app startup.
   * Returns true if successfully started listening, false otherwise.
   */
  reinitialize(): boolean {
    // If already listening, no need to reinitialize
    if (this.isListening) {
      console.log('Hold shortcuts already listening, no reinit needed')
      return true
    }

    // Reset the initAttempted flag to allow a fresh start
    this.initAttempted = false

    // Try to start listening
    const result = this.startListening()
    console.log(`Hold shortcuts reinitialize result: ${result}`)
    return result
  }

  /**
   * Get the current state of all modifier keys as tracked by uiohook.
   * Useful for verifying modifier state when globalShortcut fires.
   */
  getActiveModifiers(): { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } {
    return { ...this.activeModifiers }
  }

  /**
   * Check if a specific modifier key is currently pressed.
   * @param modifier - 'ctrl', 'meta', 'alt', or 'shift'
   */
  isModifierActive(modifier: 'ctrl' | 'meta' | 'alt' | 'shift'): boolean {
    return this.activeModifiers[modifier]
  }
}

export const holdShortcuts = new HoldShortcutsManager()
