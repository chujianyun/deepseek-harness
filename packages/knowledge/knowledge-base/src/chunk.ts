/**
 * Splitting document text into chunks of at most `size` estimated tokens, each starting with up to
 * `overlap` tokens repeated from the end of the previous one. Token counts are estimated without a
 * model tokenizer: one per Han character, one per four other non-space characters.
 *
 * Two strategies pick where a chunk ends. Smart chunking (`structured`) prefers Markdown structure
 * — headings, code fences, rules, blank lines, list items, then line and sentence ends — never ends
 * a chunk inside a code fence, and treats the separator as one more paragraph-level break.
 * Delimiter chunking ends chunks at the separator first, then at blank lines, lines, sentences, and
 * spaces. Either way the cut is the best-scoring break in the last quarter of the room a chunk has,
 * a nearer break scoring higher, and a hard cut when there is none.
 */

const HAN = /\p{Script=Han}/u
const SENTENCE_END = /[。！？；!?;]/u

/** How chunk ends are chosen. */
export type ChunkStrategy = 'structured' | 'delimiter'

/** Chunking settings of a knowledge base. */
export interface ChunkOptions {
  /** Most estimated tokens per chunk; at least 1. */
  readonly size: number
  /** Estimated tokens repeated from the previous chunk; less than `size`. */
  readonly overlap: number
  readonly strategy: ChunkStrategy
  /** Separator as typed, with `\n`, `\t`, `\r`, and `\\` escapes; required by `delimiter`. */
  readonly separator: string
}

/** Part of the room a chunk has in which its end is looked for. */
const WINDOW = 0.25
/** How much a break at the far edge of the window loses against one at the limit. */
const DISTANCE_PENALTY = 0.7

/**
 * Estimated token count of a text.
 * @param text - any text.
 * @returns the estimate, at least 1 for a text with non-space characters.
 */
export function estimateTokens(text: string): number {
  let units = 0
  for (const char of text) units += cost(char)
  return Math.ceil(units / 4)
}

/** Quarter tokens of one character. */
function cost(char: string): number {
  if (HAN.test(char)) return 4
  return char.trim() === '' ? 0 : 1
}

/**
 * Turn a separator as typed into the text it stands for.
 * @param raw - separator with `\n`, `\t`, `\r`, and `\\` escapes.
 * @returns the separator text.
 */
export function unescapeSeparator(raw: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\' }
  return raw.replace(/\\([ntr\\])/gu, (_match, code: string) => escapes[code] as string)
}

/** Break scores by UTF-16 position: a chunk may end just before that position. */
type Breaks = Map<number, number>

function addBreak(breaks: Breaks, position: number, score: number): void {
  if (score > (breaks.get(position) ?? 0)) breaks.set(position, score)
}

/** Positions just after each occurrence of `needle` in `text`. */
function afterEach(text: string, needle: string): number[] {
  const found: number[] = []
  if (needle === '') return found
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
    found.push(index + needle.length)
  }
  return found
}

/** Score of ending a chunk before a line, by what the line is. */
function lineScore(line: string, blankBefore: boolean): number {
  const heading = /^(#{1,6})\s/u.exec(line)
  if (heading !== null) return 110 - 10 * (heading[1] as string).length
  if (line.startsWith('```')) return 80
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) return 60
  if (blankBefore) return 20
  if (/^(?:[-*+]|\d+\.)\s/u.test(line)) return 5
  return 1
}

/** Start and end positions of code fences; an unclosed fence runs to the end. */
function fences(text: string, lineStarts: readonly number[]): [number, number][] {
  const regions: [number, number][] = []
  let open: number | undefined
  for (const start of lineStarts) {
    if (!text.startsWith('```', start)) continue
    if (open === undefined) { open = start; continue }
    regions.push([open, start + 3])
    open = undefined
  }
  if (open !== undefined) regions.push([open, text.length])
  return regions
}

function structuredBreaks(text: string, separator: string): { breaks: Breaks; fenced: [number, number][] } {
  const breaks: Breaks = new Map()
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') lineStarts.push(index + 1)
    else if (SENTENCE_END.test(text[index] as string)) addBreak(breaks, index + 1, 2)
  }
  let previous = ''
  let lastText = ''
  for (const [order, start] of lineStarts.entries()) {
    const line = text.slice(start, lineStarts[order + 1] ?? text.length).replace(/\n$/u, '')
    // The cut sits before the newline that ends the previous line, so the line opens the next chunk;
    // a heading, even followed by blank lines, is never left at the end of a chunk.
    if (start > 0 && line.trim() !== '' && !/^#{1,6}\s/u.test(lastText)) addBreak(breaks, start - 1, lineScore(line, previous.trim() === ''))
    previous = line
    if (line.trim() !== '') lastText = line
  }
  for (const position of afterEach(text, separator)) addBreak(breaks, position, 30)
  return { breaks, fenced: fences(text, lineStarts) }
}

function delimiterBreaks(text: string, separator: string): Breaks {
  const breaks: Breaks = new Map()
  const chain: [string, number][] = [['\n\n', 20], ['\n', 12], ['。', 10], ['. ', 8], [' ', 3]]
  for (const position of afterEach(text, separator)) addBreak(breaks, position, 100)
  for (const [needle, score] of chain) {
    for (const position of afterEach(text, needle)) addBreak(breaks, position, score)
  }
  return breaks
}

/** Whether a position falls between the two halves of a surrogate pair, where no cut may go. */
function insidePair(text: string, position: number): boolean {
  const code = text.charCodeAt(position)
  return code >= 0xDC00 && code <= 0xDFFF
}

/** Running cost in quarter tokens: entry i is the cost of the text before position i. */
function costs(text: string): Uint32Array {
  const units = new Uint32Array(text.length + 1)
  for (let index = 0; index < text.length; index++) {
    // A surrogate pair costs as its code point, counted at its first half.
    const char = insidePair(text, index) ? '' : String.fromCodePoint(text.codePointAt(index) as number)
    units[index + 1] = (units[index] as number) + (char === '' ? 0 : cost(char))
  }
  return units
}

/**
 * Split text into chunks.
 * @param text - extracted document text.
 * @param options - size, overlap, strategy, and separator.
 * @returns the chunks, trimmed and non-empty.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const separator = unescapeSeparator(options.separator)
  const { breaks, fenced } = options.strategy === 'structured'
    ? structuredBreaks(text, separator)
    : { breaks: delimiterBreaks(text, separator), fenced: [] }
  const units = costs(text)
  const budget = Math.max(1, options.size) * 4
  const overlap = Math.min(Math.max(0, options.overlap), Math.max(0, options.size - 1)) * 4
  const inFence = (position: number): boolean => fenced.some(([start, end]) => position > start && position < end)
  // Farthest position after `from` whose cost from `from` stays within `limit`; never inside a
  // surrogate pair, whose second half adds no cost.
  const farthest = (from: number, limit: number): number => {
    let low = from + 1
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if ((units[middle] as number) - (units[from] as number) <= limit) low = middle
      else high = middle - 1
    }
    return low
  }
  const chunks: string[] = []
  let cursor = 0
  while (cursor < text.length) {
    let end = farthest(cursor, budget)
    if (end < text.length) {
      const window = Math.max(1, Math.floor((end - cursor) * WINDOW))
      let best = 0
      let cut = end
      for (let position = Math.max(cursor + 1, end - window); position <= end; position++) {
        const score = breaks.get(position)
        if (score === undefined || inFence(position)) continue
        const distance = (end - position) / window
        const weighted = score * (1 - DISTANCE_PENALTY * distance * distance)
        if (weighted > best) { best = weighted; cut = position }
      }
      // Nothing to end at near the limit, which falls in a code fence: end before the fence instead.
      if (best === 0 && inFence(end)) {
        for (let position = end - window - 1; position > cursor; position--) {
          if (breaks.has(position) && !inFence(position)) { cut = position; break }
        }
      }
      end = cut
    }
    const chunk = text.slice(cursor, end).trim()
    if (chunk !== '') chunks.push(chunk)
    if (end >= text.length) break
    cursor = overlapStart(text, units, cursor, end, overlap)
  }
  return chunks
}

/**
 * Where the next chunk starts: as far back from `end` as the overlap allows, moved forward to the
 * nearest sentence start, else the nearest word start.
 */
function overlapStart(text: string, units: Uint32Array, cursor: number, end: number, overlap: number): number {
  let start = end
  while (start - 1 > cursor && (units[end] as number) - (units[start - 1] as number) <= overlap) start--
  if (insidePair(text, start)) start++
  const startsAt = (test: (before: string) => boolean): number | undefined => {
    for (let position = start; position < end; position++) if (test(text[position - 1] as string)) return position
    return undefined
  }
  return startsAt(before => before === '\n' || SENTENCE_END.test(before))
    ?? startsAt(before => before.trim() === '' || HAN.test(before))
    ?? start
}
