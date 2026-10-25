export interface ParsedMeetingNote {
  title: string
  summary: string
  personalNotes: string
  transcript: string
  hasTranscript: boolean
}

export interface SpeakingTrainerMetrics {
  wordCount: number
  fillerCount: number
  fillersPer100Words: number | null
  questionCount: number
  questionsPer100Words: number | null
  turnCount: number | null
  avgTurnWords: number | null
  longestTurnWords: number | null
  paceWpm: number | null
}

export interface SpeakingTrainerTrends {
  noteCount: number
  avgFillerRate: number | null
  avgQuestionRate: number | null
  avgLongestTurnWords: number | null
  avgPaceWpm: number | null
}

export interface SpeakingTrainerNoteSummary {
  id: string
  title: string
  preview: string
  createdAt: number
  mtime: number
}

export interface SpeakingTrainerCoaching {
  headline: string
  summary: string
  strengths: string[]
  improvements: string[]
  drills: string[]
}

export interface SpeakingTrainerOverview {
  notes: SpeakingTrainerNoteSummary[]
  trends: SpeakingTrainerTrends
}

export interface SpeakingTrainerNoteAnalysis {
  noteId: string
  title: string
  metrics: SpeakingTrainerMetrics
  coaching: SpeakingTrainerCoaching | null
  aiError?: string
  fromCache?: boolean
  updatedAt?: number
}

const SECTION_RE = /^##\s+(📌\s+Your Notes|📜\s+Transcript)\s*$/gm
const FILLER_RE = /\b(um+|uh+|uhm|erm|er|like|you know|sort of|kind of)\b/gi
const TIMESTAMPED_LINE_RE = /^\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)-(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+)$/
const SPEAKER_LINE_RE = /^(?:\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)-(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]\s*)?([^:\n]{1,40}):\s*(.+)$/

function trimSection(value: string): string {
  return (value || '')
    .replace(/^\s*---+\s*/g, '')
    .replace(/\s*---+\s*$/g, '')
    .trim()
}

function normalizeTranscriptText(text: string): string {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => {
      const timestamped = line.match(TIMESTAMPED_LINE_RE)
      const rawLine = timestamped ? timestamped[3] : line
      const speakerMatch = rawLine.match(/^([^:\n]{1,40}):\s*(.+)$/)
      return speakerMatch ? speakerMatch[2] : rawLine
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function countWords(text: string): number {
  const normalized = (text || '').trim()
  if (!normalized) return 0
  return normalized.split(/\s+/).filter(Boolean).length
}

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.round(value * 10) / 10
}

function average(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (filtered.length === 0) return null
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function parseTimecode(value: string): number | null {
  const match = (value || '').trim().match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/)
  if (!match) return null
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  const fractional = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  return (minutes * 60) + seconds + fractional
}

export function parseMeetingNoteContent(text: string, fallbackTitle = 'Meeting Note'): ParsedMeetingNote {
  const raw = (text || '').replace(/\r\n/g, '\n').trim()
  const titleMatch = raw.match(/^#\s+(.+?)\s*(?:\n+|$)/)
  const title = (titleMatch?.[1] || fallbackTitle).trim() || fallbackTitle
  const body = titleMatch ? raw.slice(titleMatch[0].length) : raw

  const sections: Array<{ name: string; start: number; end: number }> = []
  for (const match of body.matchAll(SECTION_RE)) {
    const name = match[1] === '📌 Your Notes' ? 'personalNotes' : 'transcript'
    sections.push({ name, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
  }

  let summary = ''
  let personalNotes = ''
  let transcript = ''

  if (sections.length === 0) {
    summary = trimSection(body)
  } else {
    summary = trimSection(body.slice(0, sections[0].start))
    for (let index = 0; index < sections.length; index += 1) {
      const current = sections[index]
      const next = sections[index + 1]
      const content = trimSection(body.slice(current.end, next ? next.start : body.length))
      if (current.name === 'personalNotes') personalNotes = content
      if (current.name === 'transcript') transcript = content
    }
  }

  return {
    title,
    summary,
    personalNotes,
    transcript,
    hasTranscript: transcript.length > 0
  }
}

export function computeSpeakingTrainerMetrics(transcript: string): SpeakingTrainerMetrics {
  const normalizedTranscript = normalizeTranscriptText(transcript)
  const wordCount = countWords(normalizedTranscript)
  const fillerMatches = normalizedTranscript.match(FILLER_RE) || []
  const fillerCount = fillerMatches.length
  const questionCount = (normalizedTranscript.match(/\?/g) || []).length

  let turnCount: number | null = null
  let avgTurnWords: number | null = null
  let longestTurnWords: number | null = null
  let paceWpm: number | null = null

  const turnWordCounts: number[] = []
  let minStart: number | null = null
  let maxEnd: number | null = null

  for (const rawLine of (transcript || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const speakerMatch = line.match(SPEAKER_LINE_RE)
    if (speakerMatch) {
      const content = speakerMatch[4].trim()
      const words = countWords(content)
      if (words > 0) {
        turnWordCounts.push(words)
      }
      const start = speakerMatch[1] ? parseTimecode(speakerMatch[1]) : null
      const end = speakerMatch[2] ? parseTimecode(speakerMatch[2]) : null
      if (start != null) minStart = minStart == null ? start : Math.min(minStart, start)
      if (end != null) maxEnd = maxEnd == null ? end : Math.max(maxEnd, end)
      continue
    }

    const timestamped = line.match(TIMESTAMPED_LINE_RE)
    if (timestamped) {
      const start = parseTimecode(timestamped[1])
      const end = parseTimecode(timestamped[2])
      if (start != null) minStart = minStart == null ? start : Math.min(minStart, start)
      if (end != null) maxEnd = maxEnd == null ? end : Math.max(maxEnd, end)
    }
  }

  if (turnWordCounts.length > 0) {
    turnCount = turnWordCounts.length
    avgTurnWords = roundMetric(turnWordCounts.reduce((sum, count) => sum + count, 0) / turnWordCounts.length)
    longestTurnWords = Math.max(...turnWordCounts)
  }

  if (wordCount > 0 && minStart != null && maxEnd != null && maxEnd > minStart) {
    const minutes = (maxEnd - minStart) / 60
    if (minutes > 0) {
      paceWpm = roundMetric(wordCount / minutes)
    }
  }

  return {
    wordCount,
    fillerCount,
    fillersPer100Words: wordCount > 0 ? roundMetric((fillerCount / wordCount) * 100) : null,
    questionCount,
    questionsPer100Words: wordCount > 0 ? roundMetric((questionCount / wordCount) * 100) : null,
    turnCount,
    avgTurnWords,
    longestTurnWords,
    paceWpm
  }
}

export function computeSpeakingTrainerTrends(metricsList: SpeakingTrainerMetrics[]): SpeakingTrainerTrends {
  return {
    noteCount: metricsList.length,
    avgFillerRate: roundMetric(average(metricsList.map((metrics) => metrics.fillersPer100Words))),
    avgQuestionRate: roundMetric(average(metricsList.map((metrics) => metrics.questionsPer100Words))),
    avgLongestTurnWords: roundMetric(average(metricsList.map((metrics) => metrics.longestTurnWords))),
    avgPaceWpm: roundMetric(average(metricsList.map((metrics) => metrics.paceWpm)))
  }
}
