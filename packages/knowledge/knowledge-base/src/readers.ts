/**
 * Text of a document file: Word `.docx` (mammoth), PDF (pdf.js, text layer only), Excel `.xlsx` (ExcelJS), Markdown,
 * and text.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { CellValue, Workbook } from 'exceljs'

/** File extensions a knowledge base accepts, lowercase. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.pdf', '.xlsx', '.md', '.markdown', '.txt'])

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
  } else if (ext === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(path)
    text = workbookText(book)
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

/**
 * A workbook as text, sheet by sheet: a `# 工作表: <name>` line, then each row after the first as
 * `<sheet> 第 <n> 行: <header>=<value>; …`, so a chunk names where its rows came from. The first row with
 * any value holds the headers; a column without one is named by its letter. A sheet with only that row
 * lists its columns; an empty sheet is left out. Formulas give their last calculated value, and a merged
 * range its top-left cell.
 */
function workbookText(book: Workbook): string {
  const sheets: string[] = []
  book.eachSheet((sheet) => {
    const rows: { number: number; cells: { column: number; text: string }[] }[] = []
    sheet.eachRow((row, number) => {
      const cells: { column: number; text: string }[] = []
      row.eachCell((cell, column) => {
        if (cell.isMerged && cell.master !== cell) return
        const text = valueText(cell.value).trim()
        if (text !== '') cells.push({ column, text })
      })
      if (cells.length > 0) rows.push({ number, cells })
    })
    const [header, ...data] = rows
    if (header === undefined) return
    const headers = new Map(header.cells.map(cell => [cell.column, cell.text]))
    const lines = data.length === 0
      ? [`列: ${header.cells.map(cell => cell.text).join('、')}`]
      : data.map(row => `${sheet.name} 第 ${String(row.number)} 行: ${row.cells
        .map(cell => `${headers.get(cell.column) ?? sheet.getColumn(cell.column).letter}=${cell.text}`).join('; ')}`)
    sheets.push([`# 工作表: ${sheet.name}`, ...lines].join('\n'))
  })
  return sheets.join('\n\n')
}

/** A cell value as text: dates as `YYYY-MM-DD` (with the time when it has one), formulas by their result. */
function valueText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
  }
  if (typeof value !== 'object') return String(value)
  if ('richText' in value) return value.richText.map(run => run.text).join('')
  if ('formula' in value || 'sharedFormula' in value) return valueText(value.result)
  if ('hyperlink' in value) return valueText(value.text)
  if ('error' in value) return value.error
  return ''
}
