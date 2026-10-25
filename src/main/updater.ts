import { app, BrowserWindow, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateCheckReason = 'startup' | 'manual' | 'tray' | 'background'

interface UpdaterDependencies {
  sendProgress: (message: string) => void
  getMainWindow: () => BrowserWindow | null
  getIsQuitting: () => boolean
  releasesUrl: string
}

export function createUpdaterController(deps: UpdaterDependencies) {
  let updaterInitialized = false
  let updateCheckInProgress = false
  let manualMacUpdatePrompted = false
  let manualUpdatePrompted = false
  let lastUpdateInfo: any = null
  let lastDownloadLogAt = 0
  let backgroundUpdateCheckTimer: NodeJS.Timeout | null = null
  const backgroundUpdateCheckIntervalMs = 6 * 60 * 60 * 1000
  const autoUpdateSupported = process.platform === 'linux' || process.env.NOTTO_ENABLE_IN_APP_UPDATES === '1'

  const formatUpdateBytes = (bytes?: number) => {
    const safe = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
    return `${(safe / 1024 / 1024).toFixed(1)} MB`
  }

  const promptManualMacUpdate = () => {
    if (manualMacUpdatePrompted) return
    manualMacUpdatePrompted = true

    const message = lastUpdateInfo?.version
      ? `Update ${lastUpdateInfo.version} is available, but automatic install failed.`
      : 'An update is available, but automatic install failed.'
    const detail = 'This build is not code-signed, so macOS may block in-app updates. Download the latest version manually.'
    const targetWindow = deps.getMainWindow()

    const prompt = targetWindow && !targetWindow.isDestroyed()
      ? dialog.showMessageBox(targetWindow, {
        type: 'warning',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Manual update required',
        message,
        detail
      })
      : dialog.showMessageBox({
        type: 'warning',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Manual update required',
        message,
        detail
      })

    prompt.then((result) => {
      if (result.response === 0) {
        shell.openExternal(deps.releasesUrl).catch(() => { })
      }
    }).catch(() => { })
  }

  const promptManualUpdate = () => {
    if (manualUpdatePrompted) return
    manualUpdatePrompted = true

    const message = lastUpdateInfo?.version
      ? `Update ${lastUpdateInfo.version} is available.`
      : 'A new update is available.'
    const detail = 'This build uses manual update downloads on desktop. Open the releases page to install the latest version.'
    const targetWindow = deps.getMainWindow()

    const prompt = targetWindow && !targetWindow.isDestroyed()
      ? dialog.showMessageBox(targetWindow, {
        type: 'info',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Manual update',
        message,
        detail
      })
      : dialog.showMessageBox({
        type: 'info',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Manual update',
        message,
        detail
      })

    prompt.then((result) => {
      manualUpdatePrompted = false
      if (result.response === 0) {
        shell.openExternal(deps.releasesUrl).catch(() => { })
      }
    }).catch(() => {
      manualUpdatePrompted = false
    })
  }

  const handleUpdaterError = (err: any, context: string) => {
    updateCheckInProgress = false
    const message = err?.message ?? String(err)
    deps.sendProgress(`${context}: ${message}`)
    console.error(`[Updater Error] ${context}:`, err)

    if (process.platform !== 'darwin') return

    const lower = message.toLowerCase()
    if (
      lower.includes('signature') ||
      lower.includes('codesign') ||
      lower.includes('code sign') ||
      lower.includes('not signed') ||
      lower.includes('verification') ||
      lower.includes('identity') ||
      lower.includes('authority') ||
      lower.includes('chain')
    ) {
      promptManualMacUpdate()
    }
  }

  const setupAutoUpdater = () => {
    if (updaterInitialized) return
    updaterInitialized = true

    if (!app.isPackaged) {
      deps.sendProgress('Auto-update disabled in development builds')
      return
    }

    if (!autoUpdateSupported) {
      deps.sendProgress('In-app auto-update disabled for this desktop build; manual downloads are used instead')
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.disableWebInstaller = true

    autoUpdater.on('checking-for-update', () => {
      deps.sendProgress('Checking for updates...')
    })

    autoUpdater.on('update-available', (info) => {
      updateCheckInProgress = false
      lastUpdateInfo = info
      deps.sendProgress(`Update available: ${info.version}`)
    })

    autoUpdater.on('update-not-available', () => {
      updateCheckInProgress = false
      deps.sendProgress('No updates available')
    })

    autoUpdater.on('download-progress', (progress) => {
      const now = Date.now()
      if (now - lastDownloadLogAt < 1500) return
      lastDownloadLogAt = now

      const pct = typeof progress.percent === 'number' ? progress.percent : 0
      const total = formatUpdateBytes(progress.total)
      const transferred = formatUpdateBytes(progress.transferred)
      deps.sendProgress(`Downloading update: ${pct.toFixed(1)}% (${transferred} / ${total})`)
    })

    autoUpdater.on('update-downloaded', async () => {
      deps.sendProgress('Update downloaded')
      const mainWindow = deps.getMainWindow()
      const focusedWindow = BrowserWindow.getFocusedWindow()
      const targetWindow = focusedWindow || (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null)

      try {
        const result = targetWindow
          ? await dialog.showMessageBox(targetWindow, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: 'An update has been downloaded. Restart now to install it?'
          })
          : await dialog.showMessageBox({
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: 'An update has been downloaded. Restart now to install it?'
          })

        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        } else {
          deps.sendProgress('Update will install on next quit')
        }
      } catch (e: any) {
        deps.sendProgress(`Update prompt failed: ${e?.message ?? String(e)}`)
      }
    })

    autoUpdater.on('error', (err) => {
      handleUpdaterError(err, 'Update error')
    })
  }

  const checkForUpdates = (reason: UpdateCheckReason = 'startup') => {
    const isUserInitiated = reason === 'manual' || reason === 'tray'
    if (!app.isPackaged) {
      if (isUserInitiated) {
        deps.sendProgress('Auto-update is disabled in development builds')
      }
      return
    }

    if (!autoUpdateSupported) {
      if (isUserInitiated) {
        deps.sendProgress('In-app auto-update is disabled for this desktop build')
        promptManualUpdate()
      }
      return
    }

    setupAutoUpdater()
    if (updateCheckInProgress) {
      if (isUserInitiated) {
        deps.sendProgress('Update check already in progress')
      }
      return
    }

    updateCheckInProgress = true
    if (isUserInitiated) {
      deps.sendProgress('Manual update check requested')
    }

    autoUpdater.checkForUpdates().catch((err) => {
      handleUpdaterError(err, 'Update check failed')
    })
  }

  const scheduleAutoUpdateChecks = () => {
    if (backgroundUpdateCheckTimer) return
    if (!autoUpdateSupported || !app.isPackaged) return
    backgroundUpdateCheckTimer = setInterval(() => {
      if (deps.getIsQuitting()) return
      checkForUpdates('background')
    }, backgroundUpdateCheckIntervalMs)
  }

  const stopAutoUpdateChecks = () => {
    if (!backgroundUpdateCheckTimer) return
    clearInterval(backgroundUpdateCheckTimer)
    backgroundUpdateCheckTimer = null
  }

  return {
    setupAutoUpdater,
    checkForUpdates,
    scheduleAutoUpdateChecks,
    stopAutoUpdateChecks
  }
}
