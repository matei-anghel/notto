import { app } from 'electron'

/** Passed by the OS login item so a login launch can start hidden (Windows ignores openAsHidden). */
export const OPENED_AT_LOGIN_ARG = '--opened-at-login'

/**
 * Register or remove the "open at login" entry.
 * Unpackaged runs (`npm start`) are skipped: they would register the bare electron.exe
 * as a startup program.
 */
export function applyLoginItemSettings(openAtLogin: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: true,
    args: [OPENED_AT_LOGIN_ARG]
  })
}

export function wasLaunchedHiddenAtLogin(): boolean {
  if (process.platform === 'win32') {
    return process.argv.includes(OPENED_AT_LOGIN_ARG)
  }
  const login = app.getLoginItemSettings()
  return !!(login.wasOpenedAtLogin && login.openAsHidden)
}
