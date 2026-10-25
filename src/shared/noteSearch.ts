/**
 * Local keyword search over notes (BM25) used by Chat with Notes when the user has not picked
 * notes by hand. Runs entirely on-device; no embeddings or index service required.
 */

export interface SearchableNote {
  id: string
  title: string
  text: string
  mtime: number
}

export interface RankedNote {
  id: string
  score: number
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'had',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the',
  'their', 'them', 'there', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'you', 'your', 'about', 'any', 'all', 'tell', 'said', 'say', 'notes', 'note',
])

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 3

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}

/** Rank notes by relevance to the query; only notes that share at least one term are returned. */
export function rankNotes(query: string, notes: SearchableNote[], limit = 5): RankedNote[] {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || notes.length === 0) return []

  const docs = notes.map((note) => {
    const tokens = [...Array(TITLE_WEIGHT).fill(tokenize(note.title)).flat(), ...tokenize(note.text)]
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1)
    return { note, length: tokens.length, counts }
  })
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const idf = new Map(queryTerms.map((term) => {
    const df = docs.filter((doc) => doc.counts.has(term)).length
    return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))]
  }))

  return docs
    .map(({ note, length, counts }) => {
      let score = 0
      for (const term of queryTerms) {
        const tf = counts.get(term) || 0
        if (!tf) continue
        score += idf.get(term)! * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (length / avgLength)))
      }
      return { id: note.id, score, mtime: note.mtime }
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }))
}
