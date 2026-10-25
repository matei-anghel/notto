export interface MacPermissionTruth {
  microphoneStatus: string
  screenEffective: boolean
  accessibilityTrusted: boolean
  automationApproved: boolean
  inputMonitoringApproved: boolean
  systemAudioCapturePreflightAcknowledged: boolean
}

export interface SystemAudioPreflightResult {
  preflightStarted: boolean
  screenEffective: boolean
}

export function areMacPermissionsSatisfied(state: MacPermissionTruth): boolean {
  return (
    state.microphoneStatus === 'granted' &&
    state.screenEffective === true &&
    state.accessibilityTrusted === true &&
    state.automationApproved === true &&
    state.inputMonitoringApproved === true &&
    state.systemAudioCapturePreflightAcknowledged === true
  )
}

export function shouldAcknowledgeSystemAudioCapturePreflight(result: SystemAudioPreflightResult): boolean {
  return result.preflightStarted === true || result.screenEffective === true
}
