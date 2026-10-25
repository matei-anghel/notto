import type { OnboardingWizardState, PermissionGroupId, PermissionWizardStep } from './shared/permissions'

const electronAPI = (window as any).electronAPI
const windowControls = (window as any).windowControls

document.body.classList.toggle('platform-macos', (window as any).env?.platform === 'darwin')

const stepList = document.getElementById('stepList') as HTMLElement | null
const detailEyebrow = document.getElementById('detailEyebrow') as HTMLElement | null
const detailTitle = document.getElementById('detailTitle') as HTMLElement | null
const detailSummary = document.getElementById('detailSummary') as HTMLElement | null
const detailBody = document.getElementById('detailBody') as HTMLElement | null
const detailStatusText = document.getElementById('detailStatusText') as HTMLElement | null
const detailHealthDot = document.getElementById('detailHealthDot') as HTMLElement | null
const detailHelper = document.getElementById('detailHelper') as HTMLElement | null
const primaryActionBtn = document.getElementById('primaryActionBtn') as HTMLButtonElement | null
const secondaryActionBtn = document.getElementById('secondaryActionBtn') as HTMLButtonElement | null
const finishSetupBtn = document.getElementById('finishSetupBtn') as HTMLButtonElement | null
const restartBtn = document.getElementById('restartBtn') as HTMLButtonElement | null
const resetSetupBtn = document.getElementById('resetSetupBtn') as HTMLButtonElement | null
const footerCopy = document.getElementById('footerCopy') as HTMLElement | null
const wizardIntroCopy = document.getElementById('wizardIntroCopy') as HTMLElement | null

let wizardState: OnboardingWizardState | null = null
let isBusy = false

function setBusy(next: boolean, label?: string) {
  isBusy = next
  if (primaryActionBtn) {
    primaryActionBtn.disabled = next
    if (label) primaryActionBtn.textContent = label
  }
  if (secondaryActionBtn) secondaryActionBtn.disabled = next
  if (finishSetupBtn) finishSetupBtn.disabled = next
  if (restartBtn) restartBtn.disabled = next
  if (resetSetupBtn) resetSetupBtn.disabled = next
}

function getCurrentStep(): PermissionWizardStep | null {
  if (!wizardState || !wizardState.currentStep || wizardState.currentStep === 'install_preflight') return null
  return wizardState.steps.find((step) => step.id === wizardState!.currentStep) || null
}

function getHealthClass(step: PermissionWizardStep): string {
  return step.health === 'healthy' ? 'healthy' : step.health === 'degraded' ? 'degraded' : 'unknown'
}

function getStateLabel(step: PermissionWizardStep): string {
  if (step.verified) return 'Ready'
  if (step.needsRestart) return 'Restart required'
  if (step.state === 'repair_needed') return 'Needs repair'
  if (step.state === 'needs_user_action') return 'Needs attention'
  if (step.state === 'checking') return 'Checking'
  return 'Not started'
}

async function triggerSystemAudioCapturePrompt(): Promise<boolean> {
  if (!(navigator.mediaDevices as any)?.getDisplayMedia) return false

  let stream: MediaStream | null = null
  try {
    stream = await (navigator.mediaDevices as any).getDisplayMedia({ audio: true, video: true })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return true
  } catch (err) {
    console.warn('System audio capture preflight did not start:', err)
    return false
  } finally {
    try { stream?.getTracks().forEach((track) => track.stop()) } catch { }
  }
}

function renderStepList(state: OnboardingWizardState) {
  if (!stepList) return
  stepList.innerHTML = ''

  state.steps.forEach((step, index) => {
    const item = document.createElement('div')
    item.className = `step-pill${step.verified ? ' done' : ''}${state.currentStep === step.id ? ' current' : ''}`
    item.innerHTML = `
      <div class="step-number">${step.verified ? '✓' : index + 1}</div>
      <div>
        <h3>${step.title}</h3>
        <p>${step.summary}</p>
      </div>
      <div class="step-state">${getStateLabel(step)}</div>
    `
    stepList.appendChild(item)
  })
}

function renderInstallPreflight(state: OnboardingWizardState) {
  if (detailEyebrow) detailEyebrow.textContent = 'Step 0'
  if (detailTitle) detailTitle.textContent = 'Move Notto into Applications first'
  if (detailSummary) detailSummary.textContent = 'macOS permissions are more stable when Notto runs from /Applications/Notto.app.'
  if (detailBody) detailBody.textContent = 'Drag Notto into the Applications folder, launch it from there, then restart to continue setup. Do not finish the permission steps from Downloads or another temporary folder.'
  if (detailStatusText) detailStatusText.textContent = 'Move the app, then restart'
  if (detailHealthDot) detailHealthDot.className = 'status-dot degraded'
  if (detailHelper) {
    detailHelper.style.display = 'block'
    detailHelper.textContent = 'After moving Notto, use the restart button below to reopen the app from its stable location.'
  }
  if (wizardIntroCopy) {
    wizardIntroCopy.textContent = 'Notto needs one stable macOS app location before requesting the rest of the permissions.'
  }
  if (primaryActionBtn) {
    primaryActionBtn.style.display = 'none'
  }
  if (secondaryActionBtn) {
    secondaryActionBtn.style.display = 'none'
  }
  if (finishSetupBtn) finishSetupBtn.style.display = 'none'
  if (restartBtn) {
    restartBtn.style.display = 'inline-flex'
    restartBtn.textContent = 'Restart after moving Notto'
  }
  if (footerCopy) {
    footerCopy.textContent = 'This step stays here until Notto is launched from /Applications.'
  }
}

function renderCurrentStep(state: OnboardingWizardState) {
  if (state.installPreflightRequired || state.currentStep === 'install_preflight') {
    renderInstallPreflight(state)
    return
  }

  const currentStep = getCurrentStep()
  if (!currentStep) return

  if (detailEyebrow) {
    const index = state.steps.findIndex((step) => step.id === currentStep.id)
    detailEyebrow.textContent = `Step ${index + 1}`
  }
  if (detailTitle) detailTitle.textContent = currentStep.title
  if (detailSummary) detailSummary.textContent = currentStep.summary
  if (detailBody) detailBody.textContent = currentStep.detail
  if (detailStatusText) detailStatusText.textContent = getStateLabel(currentStep)
  if (detailHealthDot) detailHealthDot.className = `status-dot ${getHealthClass(currentStep)}`
  if (wizardIntroCopy) {
    wizardIntroCopy.textContent = state.pendingRestartStep
      ? 'One step still needs a restart before Notto can verify it cleanly.'
      : 'Finish each step in order. When macOS opens System Settings, come back here and verify the step.'
  }

  if (detailHelper) {
    const helperText =
      currentStep.id === 'meeting_capture'
        ? 'Run the capture preflight before checking this step so macOS shows any picker or privacy prompt now.'
        : currentStep.id === 'global_shortcuts'
          ? 'When you click verify, hold one of your Notto shortcuts once within five seconds.'
          : currentStep.id === 'typing_access'
            ? 'If macOS opens Accessibility first, allow it there, then run the same check again for typing access.'
            : 'Click the main button to check this step directly in Notto.'

    detailHelper.style.display = 'block'
    detailHelper.textContent = helperText
  }

  if (primaryActionBtn) {
    primaryActionBtn.style.display = 'inline-flex'
    primaryActionBtn.textContent = currentStep.actionLabel
  }

  if (secondaryActionBtn) {
    secondaryActionBtn.style.display = 'inline-flex'
    secondaryActionBtn.textContent = currentStep.settingsLabel
  }

  if (restartBtn) {
    restartBtn.style.display = state.pendingRestartStep ? 'inline-flex' : 'none'
  }
  if (finishSetupBtn) {
    finishSetupBtn.style.display = state.canFinish ? 'inline-flex' : 'none'
  }
  if (footerCopy) {
    footerCopy.textContent = state.canFinish
      ? 'All required setup checks have passed.'
      : 'Notto will stay on this setup flow until every required step is verified once.'
  }
}

function renderWizard(state: OnboardingWizardState) {
  renderStepList(state)
  renderCurrentStep(state)
}

async function loadWizardState() {
  wizardState = await electronAPI.permissions.getWizardState()
  renderWizard(wizardState)
}

async function runStepCheck(step: PermissionGroupId) {
  setBusy(true, step === 'global_shortcuts' ? 'Waiting for shortcut…' : 'Checking…')

  try {
    if (step === 'meeting_capture') {
      const preflightStarted = await triggerSystemAudioCapturePrompt()
      await electronAPI.permissions.acknowledgeSystemAudioCapturePreflight(preflightStarted)
    }

    const result = await electronAPI.permissions.checkStep(step)
    if (!result?.ok) {
      throw new Error(result?.message || 'Step check failed')
    }
    wizardState = result.wizard
    renderWizard(wizardState)
  } catch (err) {
    console.error(`Failed to verify step ${step}:`, err)
    await loadWizardState()
  } finally {
    setBusy(false)
  }
}

async function handlePrimaryAction() {
  if (isBusy || !wizardState) return
  if (wizardState.installPreflightRequired) {
    await electronAPI.permissions.restartAndResume()
    return
  }
  const step = getCurrentStep()
  if (!step) return
  await runStepCheck(step.id)
}

async function handleSecondaryAction() {
  if (isBusy || !wizardState) return
  if (wizardState.installPreflightRequired) return
  const step = getCurrentStep()
  if (!step) return
  setBusy(true)
  try {
    await electronAPI.permissions.openStepSettings(step.id)
    await loadWizardState()
  } finally {
    setBusy(false)
  }
}

async function finishOnboarding() {
  if (!wizardState?.canFinish || isBusy) return
  setBusy(true, 'Finishing…')
  try {
    const result = await electronAPI.permissions.completeOnboarding()
    if (result?.ok) {
      window.location.href = 'index.html'
    }
  } catch (err) {
    console.error('Failed to complete onboarding:', err)
  } finally {
    setBusy(false)
  }
}

async function maybeAutoCheckAfterRestart() {
  if (!wizardState || !wizardState.autoCheckStep) return
  const step = wizardState.autoCheckStep
  await runStepCheck(step)
}

document.getElementById('win-min')?.addEventListener('click', () => windowControls.minimize())
document.getElementById('win-max')?.addEventListener('click', () => windowControls.toggleMaximize())
document.getElementById('win-close')?.addEventListener('click', () => windowControls.close())
primaryActionBtn?.addEventListener('click', () => void handlePrimaryAction())
secondaryActionBtn?.addEventListener('click', () => void handleSecondaryAction())
finishSetupBtn?.addEventListener('click', () => void finishOnboarding())
restartBtn?.addEventListener('click', async () => {
  if (isBusy) return
  setBusy(true, 'Restarting…')
  try {
    await electronAPI.permissions.restartAndResume()
  } finally {
    setBusy(false)
  }
})
resetSetupBtn?.addEventListener('click', async () => {
  if (isBusy) return
  setBusy(true)
  try {
    await electronAPI.permissions.resetOnboarding()
    await loadWizardState()
  } finally {
    setBusy(false)
  }
})

void loadWizardState().then(() => maybeAutoCheckAfterRestart()).catch((err) => {
  console.error('Failed to initialize permissions wizard:', err)
})
