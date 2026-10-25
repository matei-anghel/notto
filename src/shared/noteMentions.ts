export interface NoteMention {
  noteId: string
  label: string
}

export interface NoteLike {
  id: string
  name: string
  preview?: string
  createdAt?: number
  mtime?: number
}

export interface NoteMentionOption {
  noteId: string
  label: string
  title: string
  preview: string
  timestampLabel: string
  sortTime: number
}

export interface ActiveMentionQuery {
  start: number
  end: number
  query: string
}

const NOTE_TOKEN_RE = /@\[([^\]]+)\]/g
const ACCEPTABLE_PREFIX_RE = /[\s([{"'`-]/

function stripTxtExtension(value: string): string {
  return (value || '').replace(/\.txt$/i, '')
}

function parseTitleFromNoteName(name: string): string {
  const fullName = stripTxtExtension(name)
  const match = fullName.match(/^(\d{4}-\d{2}-\d{2}\s+\d{4,6})\s*-\s*(.+)$/)
  return (match ? match[2] : fullName).trim() || 'Untitled note'
}

function formatShortTimestamp(ms?: number): string {
  if (!Number.isFinite(ms) || !ms) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function getNoteMentionOptions(notes: NoteLike[]): NoteMentionOption[] {
  const items = Array.isArray(notes) ? notes : []
  const titleCounts = new Map<string, number>()

  for (const note of items) {
    const title = parseTitleFromNoteName(note.name || note.id)
    titleCounts.set(title, (titleCounts.get(title) || 0) + 1)
  }

  return items
    .map((note) => {
      const title = parseTitleFromNoteName(note.name || note.id)
      const sortTime = Number.isFinite(note.createdAt) && note.createdAt
        ? Number(note.createdAt)
        : Number.isFinite(note.mtime) ? Number(note.mtime) : 0
      const timestampLabel = formatShortTimestamp(sortTime)
      const label = (titleCounts.get(title) || 0) > 1 && timestampLabel
        ? `${title} (${timestampLabel})`
        : title

      return {
        noteId: note.id,
        label,
        title,
        preview: (note.preview || '').trim(),
        timestampLabel,
        sortTime
      }
    })
    .sort((a, b) => {
      if (b.sortTime !== a.sortTime) return b.sortTime - a.sortTime
      return a.label.localeCompare(b.label)
    })
}

export function filterNoteMentionOptions(options: NoteMentionOption[], query: string, limit = 6): NoteMentionOption[] {
  const normalizedQuery = (query || '').trim().toLowerCase()
  if (!normalizedQuery) return options.slice(0, limit)

  return options
    .filter((option) => {
      const haystack = `${option.label}\n${option.title}\n${option.preview}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
    .slice(0, limit)
}

export function detectActiveNoteMention(text: string, caretIndex: number): ActiveMentionQuery | null {
  const value = text || ''
  const caret = Math.max(0, Math.min(caretIndex, value.length))
  const beforeCaret = value.slice(0, caret)
  const atIndex = beforeCaret.lastIndexOf('@')

  if (atIndex === -1) return null

  const prefix = atIndex === 0 ? '' : value[atIndex - 1]
  if (prefix && !ACCEPTABLE_PREFIX_RE.test(prefix)) {
    return null
  }

  const rawQuery = value.slice(atIndex + 1, caret)
  if (rawQuery.includes('\n') || rawQuery.includes('\r') || rawQuery.includes(']')) {
    return null
  }
  if (rawQuery.startsWith('[')) {
    return null
  }

  return {
    start: atIndex,
    end: caret,
    query: rawQuery
  }
}

export function insertNoteMentionToken(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  option: NoteMentionOption
): { text: string; selectionStart: number; selectionEnd: number; mention: NoteMention } | null {
  const active = detectActiveNoteMention(text, selectionStart)
  if (!active) return null

  const token = `@[${option.label}] `
  const nextText = `${text.slice(0, active.start)}${token}${text.slice(selectionEnd)}`
  const nextCaret = active.start + token.length

  return {
    text: nextText,
    selectionStart: nextCaret,
    selectionEnd: nextCaret,
    mention: {
      noteId: option.noteId,
      label: option.label
    }
  }
}

export function pruneDraftNoteMentions(text: string, mentions: NoteMention[]): NoteMention[] {
  const seenNoteIds = new Set<string>()
  const next: NoteMention[] = []
  const value = text || ''

  for (const mention of Array.isArray(mentions) ? mentions : []) {
    if (!mention?.noteId || !mention?.label) continue
    const token = `@[${mention.label}]`
    if (!value.includes(token) || seenNoteIds.has(mention.noteId)) continue
    seenNoteIds.add(mention.noteId)
    next.push({ noteId: mention.noteId, label: mention.label })
  }

  return next
}

export function extractNoteMentionsFromText(text: string, draftMentions: NoteMention[]): NoteMention[] {
  const byLabel = new Map<string, NoteMention>()
  for (const mention of Array.isArray(draftMentions) ? draftMentions : []) {
    if (mention?.label && mention?.noteId && !byLabel.has(mention.label)) {
      byLabel.set(mention.label, { noteId: mention.noteId, label: mention.label })
    }
  }

  const extracted: NoteMention[] = []
  const seenNoteIds = new Set<string>()
  const value = text || ''

  for (const match of value.matchAll(NOTE_TOKEN_RE)) {
    const label = (match[1] || '').trim()
    const mention = byLabel.get(label)
    if (!mention || seenNoteIds.has(mention.noteId)) continue
    seenNoteIds.add(mention.noteId)
    extracted.push({ noteId: mention.noteId, label: mention.label })
  }

  return extracted
}

export function replaceMentionTokensForSend(text: string, mentions: NoteMention[]): string {
  let output = text || ''
  const usedMentions = extractNoteMentionsFromText(output, mentions)

  for (const mention of usedMentions) {
    const tokenRe = new RegExp(`@\\[${escapeRegExp(mention.label)}\\]`, 'g')
    output = output.replace(tokenRe, `note "${mention.label}"`)
  }

  return output
}

export function collectManualNoteIdsFromMessages(messages: Array<{ role?: string; noteMentions?: NoteMention[] }>): string[] {
  const noteIds = new Set<string>()
  for (const message of Array.isArray(messages) ? messages : []) {
    if ((message?.role || 'user') !== 'user') continue
    for (const mention of Array.isArray(message?.noteMentions) ? message.noteMentions : []) {
      if (mention?.noteId) noteIds.add(mention.noteId)
    }
  }
  return Array.from(noteIds)
}
