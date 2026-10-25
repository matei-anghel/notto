export type ChatAttachmentKind = 'image' | 'document' | 'spreadsheet' | 'presentation' | 'pdf'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachmentKind
  storagePath: string
  promptText: string
  historySummary: string
  imageDataUrls: string[]
  warnings: string[]
  blocked?: boolean
}

export const CHAT_ATTACHMENT_LIMITS = {
  maxFileAttachmentsPerSend: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxVisualAssetsPerRequest: null as number | null,
  maxCurrentPromptChars: 16_000,
  maxHistorySummaryChars: 600,
  maxTextFileChars: 8_000,
  maxSpreadsheetSheets: 5,
  maxSpreadsheetRowsPerSheet: 200,
  maxPdfPages: 12,
  maxPptSlides: 20
} as const

export function normalizeAttachmentWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function isReadyChatAttachment(attachment: ChatAttachment | null | undefined): attachment is ChatAttachment {
  return !!attachment && !attachment.blocked
}

export function trimAttachmentText(text: string, maxChars: number): string {
  const normalized = (text || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

export function summarizeAttachmentText(text: string, maxChars = CHAT_ATTACHMENT_LIMITS.maxHistorySummaryChars): string {
  return trimAttachmentText(text.replace(/\s+/g, ' '), maxChars)
}

export function serializeAttachmentContext(
  attachments: ChatAttachment[],
  options: {
    mode: 'current' | 'history'
    maxChars?: number
    maxImages?: number | null
  }
): { text: string; imageDataUrls: string[] } {
  const readyAttachments = attachments.filter(isReadyChatAttachment)
  if (readyAttachments.length === 0) {
    return { text: '', imageDataUrls: [] }
  }

  const maxChars = options.maxChars ?? CHAT_ATTACHMENT_LIMITS.maxCurrentPromptChars
  const maxImages = options.maxImages ?? CHAT_ATTACHMENT_LIMITS.maxVisualAssetsPerRequest
  const blocks: string[] = []
  let remainingChars = maxChars

  for (const attachment of readyAttachments) {
    const body = options.mode === 'current'
      ? trimAttachmentText(attachment.promptText, remainingChars)
      : summarizeAttachmentText(attachment.historySummary)

    const lines = [
      `Filename: ${attachment.name}`,
      `File type: ${attachment.mimeType || attachment.kind}`
    ]

    if (body) {
      lines.push('Content:')
      lines.push(body)
    }

    if (attachment.warnings.length > 0) {
      lines.push(`Warnings: ${attachment.warnings.join('; ')}`)
    }

    const block = lines.join('\n')
    if (!block.trim()) continue
    if (block.length > remainingChars && blocks.length > 0) break
    blocks.push(block)
    remainingChars -= block.length
    if (remainingChars <= 0) break
  }

  const imageDataUrls: string[] = []
  for (const attachment of readyAttachments) {
    for (const url of attachment.imageDataUrls || []) {
      if (maxImages !== null && imageDataUrls.length >= maxImages) break
      if (typeof url === 'string' && url.trim()) {
        imageDataUrls.push(url)
      }
    }
    if (maxImages !== null && imageDataUrls.length >= maxImages) break
  }

  if (blocks.length === 0 && imageDataUrls.length === 0) {
    return { text: '', imageDataUrls: [] }
  }

  return {
    text: blocks.length > 0 ? `Attached files:\n\n${blocks.map((block) => `---\n${block}`).join('\n\n')}` : '',
    imageDataUrls
  }
}
