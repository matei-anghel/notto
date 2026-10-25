/** Prompts for AI features that run on the user's configured models. */

export function buildAiModeSystemPrompt(hasScreenshot: boolean): string {
  return hasScreenshot
    ? "You are an AI writing assistant with access to the user's screen. Use the screenshot only as context for the user's request. Output only the requested content."
    : 'You are an AI writing assistant. Write the requested content directly and output only the final text.'
}

export function buildSpeakingTrainerSystemPrompt(): string {
  return `You are Notto's Speaking Trainer.

You coach only from transcript evidence and the supplied heuristics.
Do not infer vocal tone, confidence, emotion, interruptions, or audience reaction unless the transcript text directly supports it.
Keep feedback practical, concise, and specific to workplace meetings.

Return valid JSON only with this exact shape:
{
  "headline": string,
  "summary": string,
  "strengths": string[],
  "improvements": string[],
  "drills": string[]
}`
}

export function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = (raw || '').trim()
  if (!trimmed) throw new Error('Empty trainer response')
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || trimmed
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  const parsed = JSON.parse(first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Trainer response was not a JSON object')
  }
  return parsed as Record<string, unknown>
}

const toList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
  : []

export function normalizeSpeakingTrainerAnalysis(value: Record<string, unknown>) {
  const headline = typeof value.headline === 'string' ? value.headline.trim() : ''
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  if (!headline || !summary) throw new Error('Trainer response missing required fields')
  return {
    headline,
    summary,
    strengths: toList(value.strengths),
    improvements: toList(value.improvements),
    drills: toList(value.drills),
  }
}
