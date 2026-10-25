export const CHAT_OVERLAY_SYSTEM_PROMPT = "You are Notto, a helpful AI assistant. Respond to the user's request using the available context."

export function buildChatOverlaySystemPrompt(notesContent?: string): string {
  const trimmedNotes = typeof notesContent === 'string' ? notesContent.trim() : ''
  if (!trimmedNotes) {
    return CHAT_OVERLAY_SYSTEM_PROMPT
  }

  return `${CHAT_OVERLAY_SYSTEM_PROMPT}\n\n# Notes Context\n\n${trimmedNotes}`
}
