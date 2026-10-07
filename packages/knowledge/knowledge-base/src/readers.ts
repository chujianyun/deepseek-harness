/**
 * Text of a document file: Word `.docx` (mammoth), PDF (pdf.js, text layer only), Markdown, and text.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** File extensions a knowledge base accepts, lowercase. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pdf', '.md', '.markdown', '.txt'])

/**
 * Whether a file name has a supported extension.
 * @param name - file name or path.
 * @returns true when supported.
 */
export function isSupported(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())
}

/**
 * Read a supported document as plain text, NFKC-normalized (PDF text layers often carry
 * compatibility forms such as Kangxi radicals for common Han characters).
 * @param path - file path; its extension selects the reader.
 * @returns the text.
 * @throws when the file cannot be read or parsed.
 */
export async function readDocument(path: string): Promise<string> {
  const ext = extname(path).toLowerCase()
  let text: string
  if (ext === '.docx') {
    const { default: mammoth } = await import('mammoth')
    text = (await mammoth.extractRawText({ path })).value
  } else if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(path)) })
    const pages: string[] = []
    try {
      const document = await task.promise
      for (let number = 1; number <= document.numPages; number++) {
        const content = await (await document.getPage(number)).getTextContent()
        // pdf.js also reports marked-content boundaries as items without text.
        /* v8 ignore next */
        pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join(''))
      }
    } finally {
      await task.destroy()
    }
    text = pages.join('\n\n')
  } else {
    text = (await readFile(path, 'utf8')).replace(/^﻿/u, '')
  }
  return text.normalize('NFKC')
}
