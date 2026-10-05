/**
 * Splitting document text into chunks of about `size` tokens, each starting with up to `overlap`
 * tokens carried from the end of the previous one. Token counts are estimated without a model
 * tokenizer: one per Han character, one per four other characters.
 */

const HAN = /\p{Script=Han}/u

/**
 * Estimated token count of a text.
 * @param text - any text.
 * @returns the estimate, at least 1 for a non-empty text.
 */
export function estimateTokens(text: string): number {
  let han = 0
  let other = 0
  for (const char of text) {
    if (HAN.test(char)) han++
    else if (char.trim() !== '') other++
  }
  return han + Math.ceil(other / 4)
}

/** Paragraphs, then sentences, then hard cuts: pieces no larger than `size` tokens. */
function pieces(text: string, size: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split(/\n\s*\n/u)) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    if (estimateTokens(trimmed) <= size) { out.push(trimmed); continue }
    for (const sentence of trimmed.split(/(?<=[。！？；!?;.\n])/u)) {
      if (sentence.trim() === '') continue
      if (estimateTokens(sentence) <= size) { out.push(sentence); continue }
      let current = ''
      for (const char of sentence) {
        if (estimateTokens(current + char) > size) { out.push(current); current = '' }
        current += char
      }
      out.push(current)
    }
  }
  return out
}

/**
 * Split text into chunks.
 * @param text - extracted document text.
 * @param size - target chunk size in estimated tokens.
 * @param overlap - tokens carried from the previous chunk; smaller than `size`.
 * @returns the chunks, trimmed and non-empty.
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let tokens = 0
  for (const piece of pieces(text, size)) {
    const count = estimateTokens(piece)
    if (tokens + count > size && current.length > 0) {
      chunks.push(current.join('\n'))
      // Carry whole pieces from the end of the chunk, up to the overlap.
      const carried: string[] = []
      let carriedTokens = 0
      for (let index = current.length - 1; index >= 0; index--) {
        const kept = current[index] as string
        const next = estimateTokens(kept)
        if (carriedTokens + next > overlap || carriedTokens + next + count > size) break
        carried.unshift(kept)
        carriedTokens += next
      }
      current = carried
      tokens = carriedTokens
    }
    current.push(piece)
    tokens += count
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks.map(chunk => chunk.trim()).filter(chunk => chunk !== '')
}
