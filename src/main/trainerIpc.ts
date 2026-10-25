import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { IPC } from '../shared/ipcChannels'
import {
  computeSpeakingTrainerMetrics,
  computeSpeakingTrainerTrends,
  parseMeetingNoteContent,
  type SpeakingTrainerCoaching,
  type SpeakingTrainerNoteAnalysis,
  type SpeakingTrainerNoteSummary,
  type SpeakingTrainerOverview
} from '../shared/speakingTrainer'
import { NotesRepository } from './notesRepository'
import { chatCompletion } from './ai/aiClient'
import { buildSpeakingTrainerSystemPrompt, extractJsonObject, normalizeSpeakingTrainerAnalysis } from './ai/prompts'

interface TrainerIpcDependencies {
  notesRepository: NotesRepository
  sendProgress: (message: string) => void
  isTrustedRendererEvent: (evt: Electron.IpcMainInvokeEvent) => boolean
  blockedInvokeResult: <T extends Record<string, any>>(fallback?: T) => T & { ok: false; message: string }
}

const TRAINER_DISABLED_RESPONSE = {
  ok: false as const,
  message: 'Speaking Trainer is currently disabled.'
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
    : []
}

function normalizeCoachingPayload(value: any): SpeakingTrainerCoaching | null {
  if (!value || typeof value !== 'object') return null

  const headline = typeof value.headline === 'string' ? value.headline.trim() : ''
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  const strengths = normalizeStringList(value.strengths)
  const improvements = normalizeStringList(value.improvements)
  const drills = normalizeStringList(value.drills)

  if (!headline || !summary) return null

  return {
    headline,
    summary,
    strengths,
    improvements,
    drills
  }
}

async function buildEligibleNotesOverview(repo: NotesRepository): Promise<SpeakingTrainerOverview> {
  const items = await repo.list()
  const eligibleNotes: Array<SpeakingTrainerNoteSummary & { metrics: ReturnType<typeof computeSpeakingTrainerMetrics> }> = []

  for (const item of items) {
    try {
      const text = await repo.read(item.id)
      const parsed = parseMeetingNoteContent(text, item.name.replace(/\.txt$/i, ''))
      if (!parsed.hasTranscript) continue

      eligibleNotes.push({
        id: item.id,
        title: parsed.title || item.name.replace(/\.txt$/i, ''),
        preview: item.preview || parsed.summary || 'Meeting transcript available',
        createdAt: item.createdAt,
        mtime: item.mtime,
        metrics: computeSpeakingTrainerMetrics(parsed.transcript)
      })
    } catch {
      // Ignore unreadable notes so one bad file does not break the trainer.
    }
  }

  return {
    notes: eligibleNotes.map(({ metrics: _metrics, ...note }) => note),
    trends: computeSpeakingTrainerTrends(eligibleNotes.map((note) => note.metrics))
  }
}

async function getNoteMtime(repo: NotesRepository, noteId: string): Promise<number> {
  const stat = await fsp.stat(path.join(repo.getNotesDir(), noteId))
  return stat.mtimeMs
}

async function analyzeNoteWithAI(note: {
  title: string
  summary: string
  personalNotes: string
  transcript: string
  heuristics: ReturnType<typeof computeSpeakingTrainerMetrics>
}): Promise<SpeakingTrainerCoaching> {
  const result = await chatCompletion({
    messages: [
      { role: 'system', content: buildSpeakingTrainerSystemPrompt() },
      {
        role: 'user',
        content: `Analyze this Notto meeting transcript.

Title: ${note.title || 'Untitled meeting'}

Summary:
${note.summary || 'None'}

Personal notes:
${note.personalNotes || 'None'}

Heuristics:
${JSON.stringify(note.heuristics, null, 2)}

Transcript:
${note.transcript.slice(0, 120_000)}`,
      },
    ],
  })
  const data = { analysis: normalizeSpeakingTrainerAnalysis(extractJsonObject(result.text)) }

  const analysis = normalizeCoachingPayload(data.analysis)
  if (!analysis) {
    throw new Error('Trainer analysis returned an invalid payload')
  }

  return analysis
}

export function registerTrainerIpcHandlers(deps: TrainerIpcDependencies): void {
  ipcMain.handle(IPC.invoke.trainer.getOverview, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ overview: null })
    }

    return { ...TRAINER_DISABLED_RESPONSE, overview: null }
  })

  ipcMain.handle(IPC.invoke.trainer.analyzeNote, async (evt) => {
    if (!deps.isTrustedRendererEvent(evt)) {
      return deps.blockedInvokeResult({ analysis: null })
    }

    return { ...TRAINER_DISABLED_RESPONSE, analysis: null }
  })
}
