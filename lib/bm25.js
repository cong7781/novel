/**
 * Lexical retrieval over chunks: character-bigram BM25.
 *
 * There is no embedding endpoint on the provider this plugin talks to, and inventing one would
 * be worse than not having retrieval: a character-bigram index is exact, dependency-free,
 * deterministic, and for Chinese narrative it is a genuinely strong retriever — 4-5 grams carry
 * most of a name, and names are what a character-graph query is about.
 *
 * The index is deliberately small and rebuilt from `chunks.json` in a few hundred milliseconds,
 * so it is never the thing that has to be persisted correctly for a run to resume.
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const LATIN_OR_DIGIT = /[0-9a-zA-Z_]/

/**
 * Tokens for one document: CJK character bigrams, plus latin/digit words as whole tokens.
 * Single CJK characters are only emitted for one-character documents, because 的/了/他 as
 * unigrams would swamp the idf of every real term.
 */
export function tokenize(input) {
  const text = String(input ?? '')
  const tokens = []
  let previous = ''
  let latin = ''

  const flushLatin = () => {
    if (latin.length >= 2) tokens.push(`#${latin.toLowerCase()}`)
    latin = ''
  }

  for (const char of text) {
    if (LATIN_OR_DIGIT.test(char)) {
      if (previous !== '') {
        flushLatin()
        previous = ''
      }
      latin += char
      continue
    }
    flushLatin()
    if (CJK.test(char)) {
      if (previous !== '') tokens.push(previous + char)
      previous = char
      continue
    }
    previous = ''
  }
  flushLatin()

  if (tokens.length === 0) {
    for (const char of text) if (CJK.test(char)) tokens.push(char)
  }
  return tokens
}

/** Distinct query terms, preserving order — postings are scored once per term. */
export function queryTerms(input) {
  return [...new Set(tokenize(input))]
}

/**
 * Build a BM25 index.
 *
 * @param {{id: string|number, text: string}[]} documents
 * @param {{k1?: number, b?: number}} options
 */
export function buildIndex(documents, options = {}) {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  const postings = new Map()
  const docLengths = new Int32Array(documents.length)
  const docIds = new Array(documents.length)

  let totalLength = 0
  documents.forEach((doc, docIndex) => {
    docIds[docIndex] = doc.id
    const tokens = tokenize(doc.text)
    docLengths[docIndex] = tokens.length
    totalLength += tokens.length

    const local = new Map()
    for (const token of tokens) local.set(token, (local.get(token) ?? 0) + 1)
    for (const [token, tf] of local) {
      let posting = postings.get(token)
      if (posting === undefined) {
        posting = []
        postings.set(token, posting)
      }
      posting.push(docIndex, tf)
    }
  })

  return {
    k1,
    b,
    docCount: documents.length,
    docIds,
    docLengths,
    avgLength: documents.length === 0 ? 0 : totalLength / documents.length,
    postings,
  }
}

/**
 * Rank documents for a query. Returns documents with a non-zero score, best first.
 *
 * @returns {{docIndex: number, id: string|number, score: number}[]}
 */
export function search(index, query, options = {}) {
  const limit = options.limit ?? index.docCount
  const minScore = options.minScore ?? 0
  const terms = queryTerms(query)
  const scores = new Float64Array(index.docCount)
  const { k1, b, docLengths, avgLength, docCount, postings } = index
  if (docCount === 0 || avgLength === 0) return []

  for (const term of terms) {
    const posting = postings.get(term)
    if (posting === undefined) continue
    const df = posting.length / 2
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5))
    for (let i = 0; i < posting.length; i += 2) {
      const docIndex = posting[i]
      const tf = posting[i + 1]
      const normaliser = tf + k1 * (1 - b + (b * docLengths[docIndex]) / avgLength)
      scores[docIndex] += (idf * tf * (k1 + 1)) / normaliser
    }
  }

  const results = []
  for (let docIndex = 0; docIndex < docCount; docIndex += 1) {
    if (scores[docIndex] > minScore) {
      results.push({ docIndex, id: index.docIds[docIndex], score: scores[docIndex] })
    }
  }
  results.sort((a, b2) => b2.score - a.score || a.docIndex - b.docIndex)
  return results.slice(0, limit)
}

/** Index size, for the run manifest (never for scoring). */
export function describeIndex(index) {
  let postingEntries = 0
  for (const posting of index.postings.values()) postingEntries += posting.length / 2
  return {
    docs: index.docCount,
    terms: index.postings.size,
    postingEntries,
    avgTokens: Math.round(index.avgLength),
  }
}

/**
 * Count non-overlapping occurrences of any of `phrases` in `text`.
 * Used for co-occurrence gating, where an exact substring is a stronger signal than a BM25 score.
 */
export function countOccurrences(text, phrases) {
  let total = 0
  for (const phrase of phrases) {
    if (!phrase) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(phrase, from)
      if (at < 0) break
      total += 1
      from = at + phrase.length
    }
  }
  return total
}

/**
 * Positions of the first `limit` occurrences of any phrase, merged and sorted.
 * Retrieval for "what happens between these two" needs positions, not just counts.
 */
export function findOccurrences(text, phrases, limit = 50) {
  const hits = []
  for (const phrase of phrases) {
    if (!phrase) continue
    let from = 0
    while (hits.length < limit) {
      const at = text.indexOf(phrase, from)
      if (at < 0) break
      hits.push({ at, length: phrase.length, phrase })
      from = at + phrase.length
    }
  }
  return hits.sort((a, b) => a.at - b.at).slice(0, limit)
}
