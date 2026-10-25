export type PermissionGroupId =
  | 'microphone'
  | 'meeting_capture'
  | 'typing_access'
  | 'global_shortcuts'

export type PermissionStepState =
  | 'not_started'
  | 'needs_user_action'
  | 'checking'
  | 'verified'
  | 'needs_restart'
  | 'repair_needed'

export type CapabilityHealth = 'unknown' | 'healthy' | 'degraded'

export const PERMISSION_STEP_ORDER: PermissionGroupId[] = [
  'microphone',
  'meeting_capture',
  'typing_access',
  'global_shortcuts'
]

export interface OnboardingWizardProgress {
  currentStep: PermissionGroupId | null
  completedSteps: PermissionGroupId[]
  pendingRestartStep: PermissionGroupId | null
  completedAt: number | null
  autoCheckStep: PermissionGroupId | null
}

export interface PermissionWizardStep {
  id: PermissionGroupId
  title: string
  summary: string
  detail: string
  state: PermissionStepState
  health: CapabilityHealth
  verified: boolean
  needsRestart: boolean
  actionLabel: string
  settingsLabel: string
}

export interface OnboardingWizardState {
  installPreflightRequired: boolean
  appInApplications: boolean
  currentStep: PermissionGroupId | 'install_preflight' | null
  completedSteps: PermissionGroupId[]
  pendingRestartStep: PermissionGroupId | null
  completedAt: number | null
  autoCheckStep: PermissionGroupId | null
  onboardingCompleted: boolean
  canFinish: boolean
  steps: PermissionWizardStep[]
}

export function isPermissionStepVerified(state: PermissionStepState): boolean {
  return state === 'verified'
}
