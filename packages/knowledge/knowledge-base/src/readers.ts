/**
 * Text of a document file: Word `.docx` (mammoth), PDF (pdf.js, text layer only), Excel `.xlsx` (ExcelJS), Markdown,
 * and text.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Cell, CellValue, Workbook } from 'exceljs'

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
 * @param limits - how much of a workbook is read.
 * @returns the text.
 * @throws when the file cannot be read or parsed.
 */
export async function readDocument(path: string, limits: ReadLimits): Promise<string> {
  const ext = extname(path).toLowerCase()
  let text: string
  if (ext === '.docx') {
    const { default: mammoth } = await import('mammoth')
    text = (await mammoth.extractRawText({ path })).value
  } else if (ext === '.xlsx') {
    const { default: ExcelJS } = await import('exceljs')
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(path)
    text = workbookText(book, limits.maxWorkbookRows)
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

/** Limits on reading a document. */
export interface ReadLimits {
  /** Most data rows read from a workbook in all; later rows are left out and the text says so. */
  readonly maxWorkbookRows: number
}

/** One row's visible, non-empty cells. */
interface SheetRow { readonly number: number; readonly cells: readonly { readonly column: number; readonly text: string }[] }

/**
 * A workbook as text, sheet by sheet: a `# 工作表: <name>` line, then each data row as
 * `<sheet> 第 <n> 行: <header>=<value>; …`, so a chunk names where its rows came from. The header row is the
 * first row with two or more values (the first row when none has), and rows above it, such as a merged title,
 * become `说明:` lines; a column without a header is named by its letter. A sheet with only its header row
 * lists its columns, and an empty sheet is left out. Hidden sheets, rows, and columns are left out. A range
 * merged across rows repeats its value on every row it covers; one merged across columns counts once. After
 * `maxRows` data rows the rest are left out and a last line says so.
 */
function workbookText(book: Workbook, maxRows: number): string {
  const sheets: string[] = []
  // Updated from the sheet callbacks.
  const read = { left: maxRows, cut: false }
  book.eachSheet((sheet) => {
    if (sheet.state !== 'visible' || read.cut) return
    const rows: SheetRow[] = []
    sheet.eachRow((row, number) => {
      if (row.hidden) return
      const cells: { column: number; text: string }[] = []
      row.eachCell((cell, column) => {
        if (sheet.getColumn(column).hidden) return
        let source = cell
        if (cell.isMerged && cell.master !== cell) {
          if (cell.master.row === cell.row) return
          source = cell.master
        }
        const text = cellText(source).trim()
        if (text !== '') cells.push({ column, text })
      })
      if (cells.length > 0) rows.push({ number, cells })
    })
    const headerAt = Math.max(rows.findIndex(row => row.cells.length >= 2), 0)
    const header = rows[headerAt]
    if (header === undefined) return
    let data = rows.slice(headerAt + 1)
    if (data.length > read.left) {
      data = data.slice(0, read.left)
      read.cut = true
    }
    read.left -= data.length
    const headers = new Map(header.cells.map(cell => [cell.column, cell.text]))
    const notes = rows.slice(0, headerAt).map(row => `说明: ${row.cells.map(cell => cell.text).join(' ')}`)
    const lines = data.length === 0 && !read.cut
      ? [`列: ${header.cells.map(cell => cell.text).join('、')}`]
      : data.map(row => `${sheet.name} 第 ${String(row.number)} 行: ${row.cells
        .map(cell => `${headers.get(cell.column) ?? sheet.getColumn(cell.column).letter}=${cell.text}`).join('; ')}`)
    sheets.push([`# 工作表: ${sheet.name}`, ...notes, ...lines].join('\n'))
  })
  if (read.cut) sheets.push(`(只读取了前 ${String(maxRows)} 行数据, 其余行没有读取)`)
  return sheets.join('\n\n')
}

/**
 * A cell as text: a formula by its last calculated value, or `=<formula>` when it has none; numbers as shown
 * for percent and zero-padded formats, without floating-point noise.
 */
function cellText(cell: Cell): string {
  const value = cell.value
  if (value !== null && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    if (value.result === undefined) return 'formula' in value ? `=${value.formula}` : ''
    return typeof value.result === 'number' ? numberText(value.result, cell.numFmt) : valueText(value.result)
  }
  return typeof value === 'number' ? numberText(value, cell.numFmt) : valueText(value)
}

/** A number as its format shows it: `15%` for a percent format, zero-padded for `00000`, else without noise. */
function numberText(value: number, format: string | undefined): string {
  const plain = (number: number): string => String(Number(number.toPrecision(15)))
  if (format?.includes('%') === true) return `${plain(value * 100)}%`
  if (format !== undefined && /^0+$/u.test(format) && Number.isInteger(value)) return String(value).padStart(format.length, '0')
  return plain(value)
}

/** A cell value as text: dates as `YYYY-MM-DD` (with the time when it has one), a time of day alone as `HH:mm`. */
function valueText(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const iso = value.toISOString()
    // Excel counts days from 1899-12-30, so a time without a date lands on that day.
    if (iso < '1900') return iso.slice(11, 16)
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
  }
  if (typeof value !== 'object') return String(value)
  if ('richText' in value) return value.richText.map(run => run.text).join('')
  if ('formula' in value || 'sharedFormula' in value) return valueText(value.result)
  if ('hyperlink' in value) return valueText(value.text)
  if ('error' in value) return value.error
  return ''
}
