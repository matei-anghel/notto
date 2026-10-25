/**
 * Send Ctrl+V to the focused window on Windows from inside the main process.
 *
 * Spawning powershell.exe + WScript.Shell SendKeys takes 2-3 s on some machines (cold start,
 * Defender scanning, x64 emulation on ARM), which is longer than the clipboard is kept — the
 * user's previous clipboard was pasted instead of the dictation.
 */
const VK_CONTROL = 0x11
const VK_V = 0x56
const SCAN_CONTROL = 0x1d
const SCAN_V = 0x2f
const KEYEVENTF_KEYUP = 0x0002

type KeybdEvent = (vk: number, scan: number, flags: number, extraInfo: number) => void
let keybdEvent: KeybdEvent | null | undefined

function loadKeybdEvent(): KeybdEvent | null {
  if (keybdEvent !== undefined) return keybdEvent
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    keybdEvent = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)') as KeybdEvent
  } catch (err) {
    console.warn('In-process paste unavailable, falling back to PowerShell:', err)
    keybdEvent = null
  }
  return keybdEvent
}

/** Returns false when the native call is unavailable so the caller can fall back. */
export function sendWindowsPasteShortcut(): boolean {
  if (process.platform !== 'win32') return false
  const send = loadKeybdEvent()
  if (!send) return false
  try {
    send(VK_CONTROL, SCAN_CONTROL, 0, 0)
    send(VK_V, SCAN_V, 0, 0)
    send(VK_V, SCAN_V, KEYEVENTF_KEYUP, 0)
    send(VK_CONTROL, SCAN_CONTROL, KEYEVENTF_KEYUP, 0)
    return true
  } catch (err) {
    console.warn('In-process paste failed, falling back to PowerShell:', err)
    return false
  }
}
