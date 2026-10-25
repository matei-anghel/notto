const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const { rankNotes, tokenize } = loadTsModule(path.join(__dirname, '../src/shared/noteSearch.ts'))
const { buildNoteMarkdown, buildNoteMailto, noteExportFileName } = loadTsModule(path.join(__dirname, '../src/shared/noteExport.ts'))

const notes = [
  { id: 'a.txt', title: 'Weekly team sync', text: 'Morgan will publish the blog on Friday. Budget review next week.', mtime: 3 },
  { id: 'b.txt', title: 'Q4 product strategy', text: 'Pricing experiments and the onboarding redesign. Budget approved for Q4.', mtime: 2 },
  { id: 'c.txt', title: 'Client feedback call', text: 'Acme asked for SSO and an export to Markdown.', mtime: 1 },
  { id: 'd.txt', title: 'Ședință de planificare', text: 'Am discutat despre lansarea aplicației și bugetul.', mtime: 4 },
]

test('ranks the note that best matches the question first', () => {
  assert.deepEqual(rankNotes('What did the client say about SSO?', notes).map(r => r.id), ['c.txt'])
  assert.equal(rankNotes('When is the blog going out?', notes)[0].id, 'a.txt')
})

test('title matches outweigh body matches and ties prefer newer notes', () => {
  const ranked = rankNotes('budget', notes).map(r => r.id)
  assert.deepEqual(ranked.sort(), ['a.txt', 'b.txt'])
  assert.equal(rankNotes('product strategy budget', notes)[0].id, 'b.txt')
})

test('search is accent- and case-insensitive (non-English notes work)', () => {
  assert.deepEqual(tokenize('Ședință LANSAREA aplicației'), ['sedinta', 'lansarea', 'aplicatiei'])
  assert.equal(rankNotes('sedinta lansarea', notes)[0].id, 'd.txt')
})

test('questions with only stopwords or no overlap return nothing', () => {
  assert.deepEqual(rankNotes('what is it about?', notes), [])
  assert.deepEqual(rankNotes('kubernetes migration', notes), [])
})

test('Markdown export adds a title heading unless the note already has one', () => {
  assert.equal(buildNoteMarkdown('Weekly sync', 'Body text'), '# Weekly sync\n\nBody text\n')
  assert.equal(buildNoteMarkdown('Weekly sync', '## 🧾 Summary\nDone'), '# Weekly sync\n\n## 🧾 Summary\nDone\n')
  assert.equal(buildNoteMarkdown('Weekly sync', '# Own heading\nDone'), '# Own heading\nDone\n')
  assert.equal(buildNoteMarkdown('  ', 'x'), '# Untitled note\n\nx\n')
})

test('export file names drop characters Windows and macOS forbid', () => {
  assert.equal(noteExportFileName('Q4: plan / review?'), 'Q4 plan review.md')
  assert.equal(noteExportFileName('***'), 'Notto note.md')
})

test('email links carry the notes and shorten long notes safely', () => {
  const short = new URL(buildNoteMailto('Weekly sync', '# Weekly sync\n\nAction: ship & test'))
  assert.equal(short.protocol, 'mailto:')
  assert.equal(short.searchParams.get('subject'), 'Weekly sync')
  assert.equal(short.searchParams.get('body'), '# Weekly sync\n\nAction: ship & test')
  const long = buildNoteMailto('Long', 'x'.repeat(10_000))
  assert.ok(long.length < 2600, `mailto too long: ${long.length}`)
  assert.match(decodeURIComponent(long), /Save as \.md file/)
})
