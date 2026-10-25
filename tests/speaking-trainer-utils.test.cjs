const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const {
  parseMeetingNoteContent,
  computeSpeakingTrainerMetrics,
  computeSpeakingTrainerTrends
} = loadTsModule(path.join(__dirname, '..', 'src', 'shared', 'speakingTrainer.ts'))

test('parseMeetingNoteContent extracts summary, notes, and transcript sections', () => {
  const parsed = parseMeetingNoteContent(`# Weekly Sync

**Summary**
Aligned on the launch timeline.

---

## 📌 Your Notes

Follow up with design on onboarding copy.

---

## 📜 Transcript

[00:00-00:10] Speaker A: Um, we should finalize onboarding this week.
[00:10-00:20] Speaker B: Can we ship it on Friday?
`)

  assert.equal(parsed.title, 'Weekly Sync')
  assert.match(parsed.summary, /launch timeline/i)
  assert.match(parsed.personalNotes, /onboarding copy/i)
  assert.match(parsed.transcript, /Speaker A/)
  assert.equal(parsed.hasTranscript, true)
})

test('parseMeetingNoteContent treats plain notes as non-transcript notes', () => {
  const parsed = parseMeetingNoteContent(`# Quick Note

Remember to update the pricing page.`)

  assert.equal(parsed.title, 'Quick Note')
  assert.equal(parsed.personalNotes, '')
  assert.equal(parsed.transcript, '')
  assert.equal(parsed.hasTranscript, false)
})

test('computeSpeakingTrainerMetrics derives fillers, questions, turns, and pace from transcript text', () => {
  const metrics = computeSpeakingTrainerMetrics(`
[00:00-00:10] Speaker A: Um, I think we should simplify onboarding.
[00:10-00:20] Speaker B: Can we cut two steps?
[00:20-00:30] Speaker A: Yeah, like, remove the extra confirmation screen.
`.trim())

  assert.equal(metrics.wordCount, 19)
  assert.equal(metrics.fillerCount, 2)
  assert.equal(metrics.questionCount, 1)
  assert.equal(metrics.turnCount, 3)
  assert.equal(metrics.longestTurnWords, 7)
  assert.equal(metrics.avgTurnWords, 6.3)
  assert.equal(metrics.paceWpm, 38)
  assert.equal(metrics.fillersPer100Words, 10.5)
  assert.equal(metrics.questionsPer100Words, 5.3)
})

test('computeSpeakingTrainerMetrics returns nulls for turn and pace metrics when transcript structure is missing', () => {
  const metrics = computeSpeakingTrainerMetrics('This transcript has no speaker labels and no timestamps at all.')

  assert.equal(metrics.wordCount, 11)
  assert.equal(metrics.turnCount, null)
  assert.equal(metrics.avgTurnWords, null)
  assert.equal(metrics.longestTurnWords, null)
  assert.equal(metrics.paceWpm, null)
})

test('computeSpeakingTrainerTrends averages only available numeric metrics', () => {
  const trends = computeSpeakingTrainerTrends([
    {
      wordCount: 100,
      fillerCount: 5,
      fillersPer100Words: 5,
      questionCount: 2,
      questionsPer100Words: 2,
      turnCount: 4,
      avgTurnWords: 25,
      longestTurnWords: 40,
      paceWpm: 120
    },
    {
      wordCount: 80,
      fillerCount: 8,
      fillersPer100Words: 10,
      questionCount: 4,
      questionsPer100Words: 5,
      turnCount: null,
      avgTurnWords: null,
      longestTurnWords: null,
      paceWpm: null
    }
  ])

  assert.equal(trends.noteCount, 2)
  assert.equal(trends.avgFillerRate, 7.5)
  assert.equal(trends.avgQuestionRate, 3.5)
  assert.equal(trends.avgLongestTurnWords, 40)
  assert.equal(trends.avgPaceWpm, 120)
})
