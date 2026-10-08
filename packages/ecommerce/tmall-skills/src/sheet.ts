/** Read the worksheets of an .xlsx file as text, and write rows as CSV. */

import { strFromU8, unzipSync } from 'fflate'

/** One worksheet's name and cell texts. */
export interface Sheet {
  readonly name: string
  readonly rows: string[][]
}

/**
 * The cell texts of every worksheet, in workbook order, row by row; a missing cell is an empty string.
 * Shared strings, inline strings, and plain values are read; styles and formulas are not.
 * @param xlsx - the file's bytes.
 * @returns the worksheets.
 * @throws Error when the file is not an .xlsx workbook.
 */
export function readSheets(xlsx: Uint8Array): Sheet[] {
  const files = unzipSync(xlsx)
  const text = (path: string): string | undefined => files[path] === undefined ? undefined : strFromU8(files[path])
  const targets = new Map([...(text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/gu)].map(([tag]) => [
    /\bId="([^"]+)"/u.exec(tag)?.[1], `xl/${(/\bTarget="(?:\/?xl\/)?([^"]+)"/u.exec(tag)?.[1] ?? '')}`,
  ]))
  const named = [...(text('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/gu)].flatMap(([tag]) => {
    const path = targets.get(/\br:id="([^"]+)"/u.exec(tag)?.[1])
    return path === undefined || files[path] === undefined ? [] : [{ name: unescapeXml(/\bname="([^"]*)"/u.exec(tag)?.[1] ?? ''), path }]
  })
  const sheets = named.length > 0 ? named : Object.keys(files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/u.test(path))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b)).map(path => ({ name: `Sheet${String(sheetNumber(path))}`, path }))
  if (sheets.length === 0) throw new Error('文件里没有工作表，不是有效的 xlsx。')
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/gu)].map(([, item]) => runs(item as string))
  return sheets.map(({ name, path }) => ({ name, rows: sheetRows(text(path) as string, shared) }))
}

/**
 * The cell texts of the workbook's first worksheet.
 * @param xlsx - the file's bytes.
 * @returns the rows.
 * @throws Error when the file is not an .xlsx workbook.
 */
export function readFirstSheet(xlsx: Uint8Array): string[][] {
  return (readSheets(xlsx)[0] as Sheet).rows
}

/** The rows of one worksheet's XML. */
function sheetRows(xml: string, shared: readonly string[]): string[][] {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)].map(([, row]) => {
    const cells: string[] = []
    for (const [, attributes, inner = ''] of (row as string).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const column = columnIndex(/\br="([A-Z]+)\d+"/u.exec(attributes as string)?.[1] ?? '') ?? cells.length
      const type = /\bt="(\w+)"/u.exec(attributes as string)?.[1]
      const value = /<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1]
      const cell = type === 'inlineStr' ? runs(inner) : type === 's' ? shared[Number(value)] ?? '' : unescapeXml(value ?? '')
      while (cells.length < column) cells.push('')
      cells[column] = cell.trim()
    }
    return cells
  })
}

function sheetNumber(path: string): number {
  return Number(/(\d+)\.xml$/u.exec(path)?.[1])
}

/** The text of every `<t>` run in a string item, joined. */
function runs(item: string): string {
  return [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map(([, t]) => unescapeXml(t as string)).join('')
}

/** A column's zero-based index from its letters, or undefined without letters. */
function columnIndex(letters: string): number | undefined {
  if (letters === '') return undefined
  let index = 0
  for (let at = 0; at < letters.length; at++) index = index * 26 + letters.charCodeAt(at) - 64
  return index - 1
}

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/giu, (_match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)))
    return ({ lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' } as Record<string, string>)[entity.toLowerCase()] as string
  })
}

/**
 * Rows as CSV that Excel opens as UTF-8: a byte-order mark, CRLF line ends, and quotes where needed.
 * @param rows - the cells.
 * @returns the file's text.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (value: string): string => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return `﻿${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`
}
