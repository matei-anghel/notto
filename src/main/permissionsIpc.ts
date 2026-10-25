import { app, ipcMain, shell, systemPreferences } from 'electron'
import { IPC } from '../shared/ipcChannels'
import {
  CapabilityHealth,
  OnboardingWizardProgress,
  OnboardingWizardState,
  PERMISSION_STEP_ORDER,
  PermissionGroupId,
  PermissionStepState,
  PermissionWizardStep
} from '../shared/permissions'
import { holdShortcuts } from './holdShortcuts'
import { shouldAcknowledgeSystemAudioCapturePreflight } from './permissionUtils'

type ManualPermissionState = 'not-determined' | 'confirmed'
type ScreenRecordingStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

interface ScreenProbeResult {
  status: ScreenRecordingStatus
  effective: boolean
  sourceCount: number
  validThumbnailCount: number
  error?: string
}

interface RegisterPermissionsIpcDependencies {
  getPrefs: () => any
  savePrefs: () => void
  probeScreenRecording: () => Promise<ScreenProbeResult>
  verifyAutomationPermissionNow: () => Promise<boolean>
  reverifyManualPermissions: (force?: boolean) => Promise<void>
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
}

interface PermissionSnapshot {
  appInApplications: boolean
  onboardingCompleted: boolean
  wizardProgress: OnboardingWizardProgress
  microphoneStatus: string
  screenProbe: ScreenProbeResult
  accessibilityTrusted: boolean
  automationApproved: boolean
  inputMonitoringApproved: boolean
  holdShortcutsActive: boolean
  systemAudioCapturePreflightAcknowledged: boolean
}

function createDefaultWizardProgress(): OnboardingWizardProgress {
  return {
    currentStep: PERMISSION_STEP_ORDER[0],
    completedSteps: [],
    pendingRestartStep: null,
    completedAt: null,
    autoCheckStep: null
  }
}

function normalizeWizardProgress(prefs: any): OnboardingWizardProgress {
  const existing = prefs.permissionWizard || {}
  const completedSteps = Array.isArray(existing.completedSteps)
    ? existing.completedSteps.filter((step: string) => PERMISSION_STEP_ORDER.includes(step as PermissionGroupId))
    : []

  const currentStep = PERMISSION_STEP_ORDER.includes(existing.currentStep)
    ? existing.currentStep
    : PERMISSION_STEP_ORDER[0]

  const pendingRestartStep = PERMISSION_STEP_ORDER.includes(existing.pendingRestartStep)
    ? existing.pendingRestartStep
    : null

  const autoCheckStep = PERMISSION_STEP_ORDER.includes(existing.autoCheckStep)
    ? existing.autoCheckStep
    : null

  prefs.permissionWizard = {
    currentStep,
    completedSteps,
    pendingRestartStep,
    completedAt: typeof existing.completedAt === 'number' ? existing.completedAt : null,
    autoCheckStep
  }

  if (prefs.permissionsOnboardingCompleted === true && prefs.permissionWizard.completedSteps.length === 0) {
    prefs.permissionWizard.completedSteps = [...PERMISSION_STEP_ORDER]
    prefs.permissionWizard.completedAt = prefs.permissionWizard.completedAt || Date.now()
    prefs.permissionWizard.currentStep = null
  }

  return prefs.permissionWizard
}

function isAppInApplicationsFolder(): boolean {
  if (process.platform !== 'darwin') return true
  const exePath = app.getPath('exe')
  return exePath.startsWith('/Applications/Notto.app/')
}

async function openPrivacyPreferences(url: string, fallbackUrl: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (err: any) {
    console.error(`Failed to open privacy pane ${url}:`, err)
    try {
      await shell.openExternal(fallbackUrl)
    } catch { }
  }
}

function buildStep(
  id: PermissionGroupId,
  title: string,
  summary: string,
  detail: string,
  state: PermissionStepState,
  health: CapabilityHealth,
  actionLabel: string,
  settingsLabel: string
): PermissionWizardStep {
  return {
    id,
    title,
    summary,
    detail,
    state,
    health,
    verified: state === 'verified',
    needsRestart: state === 'needs_restart',
    actionLabel,
    settingsLabel
  }
}

function getCompletedStepsFromSteps(steps: PermissionWizardStep[]): PermissionGroupId[] {
  return steps.filter((step) => step.verified).map((step) => step.id)
}

function getFirstIncompleteStep(steps: PermissionWizardStep[]): PermissionGroupId | null {
  return steps.find((step) => !step.verified)?.id ?? null
}

function syncWizardProgress(prefs: any, steps: PermissionWizardStep[], installPreflightRequired: boolean): void {
  const progress = normalizeWizardProgress(prefs)
  const completedSteps = Array.from(new Set([...progress.completedSteps, ...getCompletedStepsFromSteps(steps)]))
  progress.completedSteps = PERMISSION_STEP_ORDER.filter((step) => completedSteps.includes(step))

  if (prefs.permissionsOnboardingCompleted === true) {
    progress.completedAt = progress.completedAt || Date.now()
    progress.currentStep = null
    progress.pendingRestartStep = null
    progress.autoCheckStep = null
    progress.completedSteps = [...PERMISSION_STEP_ORDER]
    return
  }

  if (progress.pendingRestartStep) {
    const pendingStep = steps.find((step) => step.id === progress.pendingRestartStep)
    if (pendingStep?.verified) {
      progress.pendingRestartStep = null
      progress.autoCheckStep = null
    }
  }

  if (!progress.pendingRestartStep && !installPreflightRequired) {
    progress.currentStep = getFirstIncompleteStep(steps)
  }
}

async function getPermissionSnapshot(deps: RegisterPermissionsIpcDependencies): Promise<PermissionSnapshot> {
  const prefs = deps.getPrefs()
  const wizardProgress = normalizeWizardProgress(prefs)

  if (process.platform !== 'darwin') {
    return {
      appInApplications: true,
      onboardingCompleted: true,
      wizardProgress,
      microphoneStatus: 'granted',
      screenProbe: { status: 'granted', effective: true, sourceCount: 0, validThumbnailCount: 0 },
      accessibilityTrusted: true,
      automationApproved: true,
      inputMonitoringApproved: true,
      holdShortcutsActive: true,
      systemAudioCapturePreflightAcknowledged: true
    }
  }

  const screenProbe = await deps.probeScreenRecording()
  return {
    appInApplications: isAppInApplicationsFolder(),
    onboardingCompleted: prefs.permissionsOnboardingCompleted === true,
    wizardProgress,
    microphoneStatus: systemPreferences.getMediaAccessStatus('microphone'),
    screenProbe,
    accessibilityTrusted: systemPreferences.isTrustedAccessibilityClient(false),
    automationApproved: prefs.automationApproved === true,
    inputMonitoringApproved: prefs.inputMonitoringApproved === true,
    holdShortcutsActive: holdShortcuts.isActive(),
    systemAudioCapturePreflightAcknowledged: prefs.systemAudioCapturePreflightAcknowledged === true
  }
}

function buildWizardSteps(snapshot: PermissionSnapshot): PermissionWizardStep[] {
  const shortcutPressVerified =
    snapshot.onboardingCompleted || snapshot.wizardProgress.completedSteps.includes('global_shortcuts')

  const meetingCaptureState: PermissionStepState =
    snapshot.screenProbe.effective && snapshot.systemAudioCapturePreflightAcknowledged
      ? 'verified'
      : snapshot.screenProbe.status === 'granted' && !snapshot.screenProbe.effective
        ? 'needs_restart'
        : snapshot.systemAudioCapturePreflightAcknowledged
          ? 'needs_user_action'
          : 'not_started'

  const meetingCaptureHealth: CapabilityHealth =
    snapshot.screenProbe.effective
      ? (snapshot.systemAudioCapturePreflightAcknowledged ? 'healthy' : 'degraded')
      : 'unknown'

  const typingAccessState: PermissionStepState =
    snapshot.accessibilityTrusted && snapshot.automationApproved
      ? 'verified'
      : snapshot.accessibilityTrusted || snapshot.automationApproved
        ? 'needs_user_action'
        : 'not_started'

  const typingAccessHealth: CapabilityHealth =
    snapshot.accessibilityTrusted && snapshot.automationApproved
      ? 'healthy'
      : snapshot.accessibilityTrusted || snapshot.automationApproved
        ? 'degraded'
        : 'unknown'

  let globalShortcutsState: PermissionStepState = 'not_started'
  let globalShortcutsHealth: CapabilityHealth = 'unknown'
  if (snapshot.inputMonitoringApproved && snapshot.holdShortcutsActive && shortcutPressVerified) {
    globalShortcutsState = 'verified'
    globalShortcutsHealth = 'healthy'
  } else if (snapshot.inputMonitoringApproved && snapshot.holdShortcutsActive) {
    globalShortcutsState = 'needs_user_action'
    globalShortcutsHealth = 'healthy'
  } else if (snapshot.inputMonitoringApproved && !snapshot.holdShortcutsActive) {
    globalShortcutsState = 'repair_needed'
    globalShortcutsHealth = 'degraded'
  } else if (snapshot.accessibilityTrusted) {
    globalShortcutsState = 'needs_user_action'
  }

  return [
    buildStep(
      'microphone',
      'Microphone',
      'Voice dictation and meeting transcription need microphone access.',
      snapshot.microphoneStatus === 'granted'
        ? 'Microphone access is working.'
        : 'Grant microphone access, then check again if macOS did not confirm it.',
      snapshot.microphoneStatus === 'granted' ? 'verified' : 'not_started',
      snapshot.microphoneStatus === 'granted' ? 'healthy' : 'unknown',
      snapshot.microphoneStatus === 'granted' ? 'Re-check' : 'Grant microphone access',
      'Open microphone settings'
    ),
    buildStep(
      'meeting_capture',
      'Meeting capture',
      'Screenshots and system audio capture require screen access plus one capture preflight.',
      snapshot.screenProbe.effective && snapshot.systemAudioCapturePreflightAcknowledged
        ? 'Screen capture and the macOS capture preflight are ready.'
        : snapshot.screenProbe.status === 'granted' && !snapshot.screenProbe.effective
          ? 'macOS has the permission recorded, but Notto still needs a restart to use it.'
          : 'Open Screen Recording settings, allow access, run the capture preflight, then check again.',
      meetingCaptureState,
      meetingCaptureHealth,
      meetingCaptureState === 'verified' ? 'Re-check' : 'Run capture check',
      'Open screen recording settings'
    ),
    buildStep(
      'typing_access',
      'Typing into apps',
      'Pasting dictated text into other apps needs macOS accessibility and typing automation access.',
      snapshot.accessibilityTrusted && snapshot.automationApproved
        ? 'Typing into other apps is verified.'
        : 'Allow Notto to control typing in other apps, then run the check again.',
      typingAccessState,
      typingAccessHealth,
      typingAccessState === 'verified' ? 'Re-check' : 'Check typing access',
      snapshot.accessibilityTrusted ? 'Open typing automation settings' : 'Open accessibility settings'
    ),
    buildStep(
      'global_shortcuts',
      'Global shortcuts',
      'Hold shortcuts require input monitoring and a working global listener.',
      snapshot.inputMonitoringApproved && snapshot.holdShortcutsActive && shortcutPressVerified
        ? 'Hold shortcuts are running. Press your hold shortcut once to confirm.'
        : snapshot.inputMonitoringApproved && snapshot.holdShortcutsActive
          ? 'The shortcut listener is running. Verify it by pressing one of your hold shortcuts once.'
        : snapshot.inputMonitoringApproved
          ? 'Input monitoring looks enabled, but the shortcut listener still needs repair or a restart.'
          : 'Open Input Monitoring settings, allow Notto, then verify your hold shortcut.',
      globalShortcutsState,
      globalShortcutsHealth,
      globalShortcutsState === 'verified' ? 'Verify shortcut press' : 'Verify shortcuts',
      'Open input monitoring settings'
    )
  ]
}

async function buildWizardState(deps: RegisterPermissionsIpcDependencies): Promise<OnboardingWizardState> {
  const prefs = deps.getPrefs()
  const snapshot = await getPermissionSnapshot(deps)
  const installPreflightRequired = !snapshot.appInApplications
  const steps = buildWizardSteps(snapshot)

  syncWizardProgress(prefs, steps, installPreflightRequired)

  const completedSteps = prefs.permissionsOnboardingCompleted === true
    ? [...PERMISSION_STEP_ORDER]
    : prefs.permissionWizard.completedSteps

  const firstIncompleteStep = getFirstIncompleteStep(steps)
  const pendingRestartStep = prefs.permissionWizard.pendingRestartStep
  const currentStep = installPreflightRequired
    ? 'install_preflight'
    : pendingRestartStep || firstIncompleteStep

  return {
    installPreflightRequired,
    appInApplications: snapshot.appInApplications,
    currentStep,
    completedSteps,
    pendingRestartStep,
    completedAt: prefs.permissionWizard.completedAt,
    autoCheckStep: prefs.permissionWizard.autoCheckStep,
    onboardingCompleted: prefs.permissionsOnboardingCompleted === true,
    canFinish: !installPreflightRequired && steps.every((step) => step.verified),
    steps
  }
}

function finalizePermissionsOnboarding(deps: RegisterPermissionsIpcDependencies): void {
  const prefs = deps.getPrefs()
  normalizeWizardProgress(prefs)
  prefs.permissionsOnboardingCompleted = true
  prefs.permissionWizard.completedSteps = [...PERMISSION_STEP_ORDER]
  prefs.permissionWizard.currentStep = null
  prefs.permissionWizard.pendingRestartStep = null
  prefs.permissionWizard.autoCheckStep = null
  prefs.permissionWizard.completedAt = Date.now()
  deps.savePrefs()

  try {
    if (process.platform === 'darwin' && prefs.inputMonitoringApproved === true && !holdShortcuts.isActive()) {
      holdShortcuts.reinitialize()
    }
  } catch { }
}

function setRestartPending(prefs: any, step: PermissionGroupId | null): void {
  const progress = normalizeWizardProgress(prefs)
  progress.pendingRestartStep = step
  progress.autoCheckStep = step
  if (step) {
    progress.currentStep = step
  }
}

async function checkPermissionStep(
  deps: RegisterPermissionsIpcDependencies,
  step: PermissionGroupId
): Promise<{ ok: true; wizard: OnboardingWizardState; step: PermissionWizardStep } | { ok: false; message: string }> {
  if (process.platform !== 'darwin') {
    const wizard = await buildWizardState(deps)
    return { ok: true, wizard, step: wizard.steps.find((item) => item.id === step)! }
  }

  const prefs = deps.getPrefs()
  normalizeWizardProgress(prefs)
  if (prefs.permissionWizard.autoCheckStep === step) {
    prefs.permissionWizard.autoCheckStep = null
  }

  try {
    if (step === 'microphone') {
      if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
        await systemPreferences.askForMediaAccess('microphone')
      }
    } else if (step === 'meeting_capture') {
      const probe = await deps.probeScreenRecording()
      if (probe.status === 'granted' && !probe.effective) {
        setRestartPending(prefs, step)
      } else if (probe.effective && prefs.systemAudioCapturePreflightAcknowledged !== true) {
        prefs.permissionWizard.currentStep = step
      }
    } else if (step === 'typing_access') {
      const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false) || systemPreferences.isTrustedAccessibilityClient(true)
      if (accessibilityGranted) {
        const automationGranted = await deps.verifyAutomationPermissionNow()
        if (automationGranted) {
          prefs.automationApproved = true
        }
      }
    } else if (step === 'global_shortcuts') {
      const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false)
      if (accessibilityGranted) {
        const started = holdShortcuts.isActive() || holdShortcuts.reinitialize()
        if (started) {
          prefs.inputMonitoringApproved = true
          const verifiedPress = await holdShortcuts.verifyShortcutPress(5000)
          if (!verifiedPress) {
            prefs.permissionWizard.currentStep = step
          } else if (!prefs.permissionWizard.completedSteps.includes(step)) {
            prefs.permissionWizard.completedSteps.push(step)
          }
        } else if (prefs.inputMonitoringApproved === true) {
          setRestartPending(prefs, step)
        }
      }
    }

    deps.savePrefs()
    const wizard = await buildWizardState(deps)
    const nextStep = wizard.steps.find((item) => item.id === step)
    if (!nextStep) {
      return { ok: false, message: 'Unknown step' }
    }
    return { ok: true, wizard, step: nextStep }
  } catch (err: any) {
    console.error(`Failed to check permission step ${step}:`, err)
    return { ok: false, message: err?.message ?? 'Permission check failed' }
  }
}

export function registerPermissionsIpcHandlers(deps: RegisterPermissionsIpcDependencies): void {
  ipcMain.handle(IPC.invoke.permissions.getStatus, async () => {
    if (process.platform !== 'darwin') {
      return {
        microphone: 'granted' as const,
        screen: 'granted' as const,
        screenEffective: true,
        automation: true,
        accessibility: true,
        inputMonitoring: true,
        automationState: 'confirmed' as ManualPermissionState,
        inputMonitoringState: 'confirmed' as ManualPermissionState,
        automationVerifiable: false,
        inputMonitoringVerifiable: false,
        systemAudioCapturePreflightNeeded: false,
        systemAudioCapturePreflightAcknowledged: true
      }
    }

    try {
      const snapshot = await getPermissionSnapshot(deps)
      return {
        microphone: snapshot.microphoneStatus,
        screen: snapshot.screenProbe.status,
        screenEffective: snapshot.screenProbe.effective,
        automation: snapshot.automationApproved,
        accessibility: snapshot.accessibilityTrusted,
        inputMonitoring: snapshot.inputMonitoringApproved,
        automationState: snapshot.automationApproved ? 'confirmed' as ManualPermissionState : 'not-determined' as ManualPermissionState,
        inputMonitoringState: snapshot.inputMonitoringApproved ? 'confirmed' as ManualPermissionState : 'not-determined' as ManualPermissionState,
        automationVerifiable: false,
        inputMonitoringVerifiable: false,
        systemAudioCapturePreflightNeeded: !snapshot.systemAudioCapturePreflightAcknowledged,
        systemAudioCapturePreflightAcknowledged: snapshot.systemAudioCapturePreflightAcknowledged
      }
    } catch (err: any) {
      console.error('Failed to get permission status:', err)
      return {
        microphone: 'unknown' as const,
        screen: 'unknown' as const,
        screenEffective: false,
        automation: false,
        accessibility: false,
        inputMonitoring: false,
        automationState: 'not-determined' as ManualPermissionState,
        inputMonitoringState: 'not-determined' as ManualPermissionState,
        automationVerifiable: false,
        inputMonitoringVerifiable: false,
        systemAudioCapturePreflightNeeded: true,
        systemAudioCapturePreflightAcknowledged: false
      }
    }
  })

  ipcMain.handle(IPC.invoke.permissions.getWizardState, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ steps: [] })
    }
    return await buildWizardState(deps)
  })

  ipcMain.handle(IPC.invoke.permissions.checkStep, async (evt, step: PermissionGroupId) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (!PERMISSION_STEP_ORDER.includes(step)) {
      return { ok: false, message: 'Unknown permission step' }
    }
    return await checkPermissionStep(deps, step)
  })

  ipcMain.handle(IPC.invoke.permissions.openStepSettings, async (evt, step: PermissionGroupId) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return { ok: true }

    const prefs = deps.getPrefs()
    const snapshot = await getPermissionSnapshot(deps)

    try {
      if (step === 'microphone') {
        await openPrivacyPreferences(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
          'x-apple.systempreferences:com.apple.preference.security?Privacy'
        )
      } else if (step === 'meeting_capture') {
        await openPrivacyPreferences(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
          'x-apple.systempreferences:com.apple.preference.security?Privacy'
        )
      } else if (step === 'typing_access') {
        if (!snapshot.accessibilityTrusted) {
          await openPrivacyPreferences(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
            'x-apple.systempreferences:com.apple.preference.security?Privacy'
          )
        } else {
          await openPrivacyPreferences(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
            'x-apple.systempreferences:com.apple.preference.security?Privacy'
          )
        }
      } else if (step === 'global_shortcuts') {
        await openPrivacyPreferences(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
          'x-apple.systempreferences:com.apple.preference.security?Privacy'
        )
      }

      normalizeWizardProgress(prefs).currentStep = step
      deps.savePrefs()
      return { ok: true }
    } catch (err: any) {
      console.error(`Failed to open settings for step ${step}:`, err)
      return { ok: false, message: err?.message ?? 'Failed to open settings' }
    }
  })

  ipcMain.handle(IPC.invoke.permissions.restartAndResume, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    app.relaunch()
    app.quit()
  })

  ipcMain.handle(IPC.invoke.permissions.resetOnboarding, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    const prefs = deps.getPrefs()
    prefs.permissionsOnboardingCompleted = false
    prefs.automationApproved = false
    prefs.inputMonitoringApproved = false
    prefs.systemAudioCapturePreflightAcknowledged = false
    prefs.permissionWizard = createDefaultWizardProgress()
    deps.savePrefs()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.permissions.probeScreenRecording, async () => {
    if (process.platform !== 'darwin') {
      return { status: 'granted' as const, effective: true, sourceCount: 0, validThumbnailCount: 0 }
    }
    return await deps.probeScreenRecording()
  })

  ipcMain.handle(IPC.invoke.permissions.requestMicrophone, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return false
    if (process.platform !== 'darwin') return true

    try {
      return await systemPreferences.askForMediaAccess('microphone')
    } catch (err: any) {
      console.error('Failed to request microphone permission:', err)
      return false
    }
  })

  ipcMain.handle(IPC.invoke.permissions.requestAccessibility, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return false
    if (process.platform !== 'darwin') return true

    try {
      return systemPreferences.isTrustedAccessibilityClient(true)
    } catch (err: any) {
      console.error('Failed to request accessibility permission:', err)
      return false
    }
  })

  ipcMain.handle(IPC.invoke.permissions.requestAutomation, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return false
    if (process.platform !== 'darwin') return true

    try {
      const prefs = deps.getPrefs()
      const result = await deps.verifyAutomationPermissionNow()
      prefs.automationApproved = result
      deps.savePrefs()
      return result
    } catch (err: any) {
      console.error('Failed to request automation permission:', err)
      return false
    }
  })

  ipcMain.handle(IPC.invoke.permissions.openScreenRecordingPreferences, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return

    try {
      await openPrivacyPreferences(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      )
    } catch (err: any) {
      console.error('Failed to open screen recording preferences:', err)
    }
  })

  ipcMain.handle(IPC.invoke.permissions.openMicrophonePreferences, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return

    try {
      await openPrivacyPreferences(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      )
    } catch (err: any) {
      console.error('Failed to open microphone preferences:', err)
    }
  })

  ipcMain.handle(IPC.invoke.permissions.openAccessibilityPreferences, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return

    try {
      await openPrivacyPreferences(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      )
    } catch (err: any) {
      console.error('Failed to open accessibility preferences:', err)
    }
  })

  ipcMain.handle(IPC.invoke.permissions.openAutomationPreferences, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return

    try {
      await openPrivacyPreferences(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      )
    } catch (err: any) {
      console.error('Failed to open automation preferences:', err)
    }
  })

  ipcMain.handle(IPC.invoke.permissions.requestInputMonitoring, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return false
    if (process.platform !== 'darwin') return true

    try {
      const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false)
      if (!accessibilityGranted) return false

      const ok = holdShortcuts.reinitialize()
      try { holdShortcuts.stopListening() } catch { }

      const prefs = deps.getPrefs()
      if (ok) {
        prefs.inputMonitoringApproved = true
      }
      deps.savePrefs()
      return ok
    } catch (err: any) {
      console.error('Failed to request input monitoring permission:', err)
      return false
    }
  })

  ipcMain.handle(IPC.invoke.permissions.acknowledgeSystemAudioCapturePreflight, async (evt, preflightStarted?: boolean) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return { ok: true }

    const screenProbe = await deps.probeScreenRecording()
    if (!shouldAcknowledgeSystemAudioCapturePreflight({
      preflightStarted: preflightStarted === true,
      screenEffective: screenProbe.effective
    })) {
      return { ok: false, message: 'system audio preflight not completed' }
    }

    const prefs = deps.getPrefs()
    prefs.systemAudioCapturePreflightAcknowledged = true
    normalizeWizardProgress(prefs).currentStep = 'meeting_capture'
    deps.savePrefs()
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.permissions.openInputMonitoringPreferences, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    if (process.platform !== 'darwin') return

    try {
      await openPrivacyPreferences(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      )
    } catch (err: any) {
      console.error('Failed to open input monitoring preferences:', err)
    }
  })

  ipcMain.handle(IPC.invoke.permissions.getDebugInfo, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return {
        platform: process.platform,
        isPackaged: app.isPackaged,
        appName: app.getName(),
        appVersion: app.getVersion(),
        appPath: app.getAppPath(),
        execPath: process.execPath,
        exePath: app.getPath('exe'),
        microphoneStatus: 'unknown',
        screenStatus: 'unknown',
        screenEffective: false,
        screenSourceCount: 0,
        screenValidThumbnailCount: 0,
        screenProbeError: 'blocked',
        accessibilityTrusted: false,
        automationApproved: false
      }
    }

    if (process.platform !== 'darwin') {
      return {
        platform: process.platform,
        isPackaged: app.isPackaged,
        appName: app.getName(),
        appVersion: app.getVersion(),
        appPath: app.getAppPath(),
        execPath: process.execPath,
        exePath: app.getPath('exe')
      }
    }

    const snapshot = await getPermissionSnapshot(deps)
    return {
      platform: process.platform,
      isPackaged: app.isPackaged,
      appName: app.getName(),
      appVersion: app.getVersion(),
      appPath: app.getAppPath(),
      execPath: process.execPath,
      exePath: app.getPath('exe'),
      appInApplications: snapshot.appInApplications,
      microphoneStatus: snapshot.microphoneStatus,
      screenStatus: snapshot.screenProbe.status,
      screenEffective: snapshot.screenProbe.effective,
      screenSourceCount: snapshot.screenProbe.sourceCount,
      screenValidThumbnailCount: snapshot.screenProbe.validThumbnailCount,
      screenProbeError: snapshot.screenProbe.error || null,
      accessibilityTrusted: snapshot.accessibilityTrusted,
      automationApproved: snapshot.automationApproved,
      inputMonitoringApproved: snapshot.inputMonitoringApproved
    }
  })

  ipcMain.handle(IPC.invoke.permissions.completeOnboarding, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult()
    const wizard = await buildWizardState(deps)
    if (!wizard.canFinish) {
      return { ok: false, message: 'Permissions setup is not complete yet' }
    }
    finalizePermissionsOnboarding(deps)
    return { ok: true }
  })

  ipcMain.handle(IPC.invoke.permissions.reinitializeHoldShortcuts, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return deps.blockedInvokeResult({ needsRestart: false })
    if (process.platform !== 'darwin') {
      return { ok: true, message: 'Not macOS, hold shortcuts already active' }
    }

    try {
      const accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false)
      if (!accessibilityGranted) {
        return { ok: false, message: 'Accessibility permission not granted yet' }
      }

      const success = holdShortcuts.reinitialize()
      if (success) {
        deps.sendProgress('✓ Hold shortcuts reinitialized successfully')
        return { ok: true, message: 'Hold shortcuts reinitialized' }
      }

      return { ok: false, needsRestart: true, message: 'Reinitialize failed - app restart required' }
    } catch (err: any) {
      console.error('Failed to reinitialize hold shortcuts:', err)
      return { ok: false, needsRestart: true, message: err?.message ?? 'Unknown error' }
    }
  })

  ipcMain.handle(IPC.invoke.permissions.needsOnboarding, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) return false
    if (process.platform !== 'darwin') return false
    return deps.getPrefs().permissionsOnboardingCompleted !== true
  })
}
