export interface MicPromptState {
  micSuppressUntilInactive: boolean
  dictationActive: boolean
  aiModeActive: boolean
  chatInitiatedDictation: boolean
  currentMicSessionDismissed: boolean
  isMeetingActive: boolean
}

export function shouldShowMicPrompt(state: MicPromptState): boolean {
  return (
    !state.micSuppressUntilInactive &&
    !state.dictationActive &&
    !state.aiModeActive &&
    !state.chatInitiatedDictation &&
    !state.currentMicSessionDismissed &&
    !state.isMeetingActive
  )
}
