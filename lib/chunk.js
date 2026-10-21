/**
 * Sliding-window chunking for long narrative text.
 *
 * The unit of work is a chunk that a single model call can quote from. Everything here is pure
 * and deterministic: the same text and options always produce the same chunks, which is what
 * makes a run resumable and a measurement reproducible.
 *
 * Two rules shape the cuts:
 *   1. never cut inside a sentence if a sentence boundary is available in the window — evidence is
 *      quoted verbatim, and a chunk that starts mid-sentence wastes the model's budget on a
 *      fragment it cannot use;
 *   2. consecutive chunks overlap by ~10% so a relationship that straddles a cut is still fully
 *      visible in at least one chunk. The merge stage then deduplicates the repeated evidence.
 */

export const DEFAULT_CHUNK_OPTIONS = Object.freeze({
  /** Preferred chunk size in characters. Measured: 3,500 keeps every pair the single call found
   *  on the 8.8k fixture while still fitting comfortably in one model reply. */
  target: 3500,
  /** Lower bound before a cut is even considered. */
  min: 2600,
  /** Upper bound; a chunk never exceeds this. */
  max: 5000,
  /** Fraction of the chunk shared with the previous one. */
  overlap: 0.12,
})

/** Punctuation that ends a thought. Cutting after these keeps a quote self-contained. */
const SENTENCE_END = '。！？!?…'
const CLOSING_QUOTES = '」』”’"\''
const SOFT_END = '；;'
const WEAK_END = '，,、'

/**
 * Split `text` into overlapping chunks.
 *
 * @param {string} text
 * @param {Partial<typeof DEFAULT_CHUNK_OPTIONS>} options
 * @returns {{index: number, start: number, end: number, chars: number, overlapPrev: number}[]}
 */
export function chunkText(text, options = {}) {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  const target = Math.max(200, Math.round(opts.target))
  const min = Math.max(50, Math.min(Math.round(opts.min), target))
  const max = Math.max(target, Math.round(opts.max))
  const overlapChars = Math.max(0, Math.round(target * Math.min(0.5, Math.max(0, opts.overlap))))
  const length = text.length

  if (length === 0) return []
  if (length <= max) {
    return [{ index: 0, start: 0, end: length, chars: length, overlapPrev: 0 }]
  }

  const chunks = []
  let start = 0
  while (start < length) {
    const lo = Math.min(length, start + min)
    const hi = Math.min(length, start + max)
    const ideal = Math.min(length, start + target)
    const end = hi >= length ? length : pickCut(text, lo, hi, ideal)
    chunks.push({
      index: chunks.length,
      start,
      end,
      chars: end - start,
      overlapPrev: chunks.length === 0 ? 0 : Math.max(0, chunks[chunks.length - 1].end - start),
    })
    if (end >= length) break

    // The next window starts `overlapChars` before the cut, then moves back to the start of a
    // sentence so the overlap begins at a natural boundary instead of mid-clause.
    let next = Math.max(start + 1, end - overlapChars)
    next = snapToBoundary(text, next, Math.max(start + 1, end - overlapChars - 160), end)
    if (next <= start) next = start + 1

    // A trailing fragment shorter than `min` is not worth its own call if we can absorb it into
    // the chunk we just cut: the last chunk is allowed to be long, never orphaned.
    if (length - next < min && end < length) {
      const stretched = length
      chunks[chunks.length - 1] = {
        index: chunks[chunks.length - 1].index,
        start,
        end: stretched,
        chars: stretched - start,
        overlapPrev: chunks[chunks.length - 1].overlapPrev,
      }
      break
    }
    start = next
  }

  return chunks
}

/**
 * Choose a cut position in [lo, hi]: punctuation quality minus distance from the ideal size.
 * Returns a position that is strictly greater than `lo`, so a chunk always grows.
 */
function pickCut(text, lo, hi, ideal) {
  const span = Math.max(1, ideal - lo)
  let best = -1
  let bestScore = -Infinity

  for (let at = lo; at < hi; at += 1) {
    const char = text[at]
    let weight = 0
    if (char === '\n') {
      const paragraph = text[at + 1] === '\n' || text[at - 1] === '\n'
      weight = paragraph ? 4 : 1.9
    } else if (SENTENCE_END.includes(char)) {
      weight = 2.4
    } else if (CLOSING_QUOTES.includes(char)) {
      weight = 2.1
    } else if (SOFT_END.includes(char)) {
      weight = 1.4
    } else if (WEAK_END.includes(char)) {
      weight = 0.6
    }
    if (weight === 0) continue

    const cut = at + 1
    if (cut <= lo) continue
    const score = weight - (Math.abs(cut - ideal) / span) * 2.5
    if (score > bestScore) {
      bestScore = score
      best = cut
    }
  }

  if (best > lo) return best
  return Math.min(hi, Math.max(lo + 1, ideal))
}

/**
 * Move `from` backwards to the first character after a sentence/paragraph boundary, without
 * going past `floor`. Falling back to `from` keeps the overlap exact when there is no boundary.
 */
function snapToBoundary(text, from, floor, ceiling) {
  for (let at = from; at > floor; at -= 1) {
    const char = text[at - 1]
    if (char === '\n' || SENTENCE_END.includes(char) || CLOSING_QUOTES.includes(char)) {
      if (at < ceiling) return at
    }
  }
  return from
}

/** Coverage/diagnostics used by the assertions and by the run manifest. */
export function describeChunks(chunks, textLength) {
  let covered = 0
  let previousEnd = 0
  let maxChars = 0
  let minChars = Number.POSITIVE_INFINITY
  for (const chunk of chunks) {
    covered += Math.max(0, chunk.end - Math.max(chunk.start, previousEnd))
    previousEnd = Math.max(previousEnd, chunk.end)
    maxChars = Math.max(maxChars, chunk.chars)
    minChars = Math.min(minChars, chunk.chars)
  }
  return {
    count: chunks.length,
    covered,
    coverage: textLength === 0 ? 1 : covered / textLength,
    maxChars,
    minChars: chunks.length === 0 ? 0 : minChars,
    overlapChars: chunks.reduce((sum, chunk) => sum + chunk.overlapPrev, 0),
  }
}
