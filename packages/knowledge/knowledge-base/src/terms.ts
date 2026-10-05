/**
 * Keyword terms for the full-text index: Han text becomes its characters and adjacent pairs (FTS5's
 * default tokenizer would keep a whole Han run as one token, so a two-character query could never
 * match inside a sentence); other letters and digits become lowercase words.
 */

const RUN = /\p{Script=Han}+|[\p{L}\p{N}]+/gu
const HAN = /\p{Script=Han}/u

/**
 * Terms of a text, in order, with repeats.
 * @param text - document or query text.
 * @returns terms for indexing or matching.
 */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const [run] of text.normalize('NFKC').toLowerCase().matchAll(RUN)) {
    if (!HAN.test(run)) {
      out.push(run)
      continue
    }
    const pairs: string[] = []
    let previous = ''
    for (const char of run) {
      out.push(char)
      if (previous !== '') pairs.push(previous + char)
      previous = char
    }
    out.push(...pairs)
  }
  return out
}

/**
 * An FTS5 MATCH expression accepting any of a query's terms.
 * @param query - query text.
 * @returns the expression, or undefined when the query has no terms.
 */
export function matchExpression(query: string): string | undefined {
  const unique = [...new Set(terms(query))]
  return unique.length === 0 ? undefined : unique.map(term => `"${term}"`).join(' OR ')
}
