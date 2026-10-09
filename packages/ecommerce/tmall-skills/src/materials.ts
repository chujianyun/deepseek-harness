/**
 * The inventory of a product's material folder, whatever its layout: every image with its size,
 * transparency, white border, and the kind it is sorted into; every table with its columns and the
 * SKU field each column is suggested for; documents and videos by name. Sorting goes by rules first
 * (the file's name, then its folders' names, then its shape and pixels); what no rule settles is left
 * for the model to decide.
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { IMAGE_EXTENSIONS, imageFormat, readImage, type ImageFacts } from './images.ts'
import { readSheets } from './sheet.ts'

/** The kinds an image is sorted into. */
export type ImageKind = 'main' | 'main34' | 'white' | 'transparent' | 'detail' | 'sku' | 'other' | 'unknown'

/** How each kind is named to the user. */
export const KIND_LABEL: Readonly<Record<ImageKind, string>> = {
  main: '1:1 主图', main34: '3:4 主图', white: '白底图', transparent: '透明素材图', detail: '详情图', sku: 'SKU 图', other: '其他素材', unknown: '待判断',
}

/** One image of the folder. */
export interface ImageEntry {
  /** The path under the folder, with `/` separators. */
  readonly file: string
  readonly facts?: ImageFacts
  readonly kind: ImageKind
  /** Why the image got its kind. */
  readonly reason: string
  readonly warnings: readonly string[]
}

/** The SKU fields a table column can hold. */
export type SkuField = 'index' | 'name' | 'code' | 'count' | 'price' | 'stock' | 'unitPrice'

/** How each SKU field is named to the user. */
export const SKU_FIELD_LABEL: Readonly<Record<SkuField, string>> = {
  index: 'SKU 序号', name: 'SKU 名称', code: '商家编码', count: '规格数量（只数）', price: '价格', stock: '库存', unitPrice: '单件价（只用于复核）',
}

/** One column of a table. */
export interface TableColumn {
  readonly header: string
  /** The field the header's name suggests; undefined when no rule recognizes it. */
  readonly field?: SkuField
  readonly samples: readonly string[]
}

/** One worksheet or CSV file with a header row. */
export interface TableEntry {
  readonly file: string
  readonly sheet: string
  readonly columns: readonly TableColumn[]
  /** The rows under the header that have any cell filled. */
  readonly rows: readonly (readonly string[])[]
}

/** Everything found in a folder. */
export interface Inventory {
  readonly folder: string
  readonly images: readonly ImageEntry[]
  readonly tables: readonly TableEntry[]
  readonly documents: readonly string[]
  readonly videos: readonly string[]
  readonly others: readonly string[]
  /** Files that could not be read, with the reason. */
  readonly unreadable: readonly { readonly file: string; readonly error: string }[]
}

/** Name hints, in order: the first that matches a name decides. */
const KIND_HINTS: readonly (readonly [RegExp, ImageKind | 'mainFamily'])[] = [
  [/sku|颜色分类|规格图|款式图/iu, 'sku'],
  [/详情|detail|描述/iu, 'detail'],
  [/白底|纯白|white/iu, 'white'],
  [/透明|transparent|抠图/iu, 'transparent'],
  [/场景|scene|模特|氛围/iu, 'other'],
  [/主图|方图|首图|轮播|main/iu, 'mainFamily'],
]

/** Header names of each SKU field, compared after {@link headerKey}. */
const FIELD_NAMES: Readonly<Record<SkuField, readonly string[]>> = {
  index: ['sku序号', '序号', 'sku编号', '规格序号'],
  name: ['上架名称', 'sku名称', '规格名称', '销售规格', '颜色分类', '规格', 'sku名', '名称', '款式'],
  code: ['商家编码', 'sku编码', '编码', '货号', '外部编码', '商品编码', '规格编码'],
  count: ['只数', '数量', '片数', '入数', '规格数量', '支数', '个数'],
  price: ['到手价', '价格', '售价', '一口价', 'sku价格', '销售价', '零售价'],
  stock: ['库存', '库存数量', '可售库存'],
  unitPrice: ['片单价', '单只价', '单片价', '每只价格'],
}

const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.doc', '.pdf', '.txt', '.md', '.pptx'])
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm'])

/**
 * A header's comparable name: full-width forms folded, lower case, without spaces or bracketed units.
 * @param header - the header cell.
 * @returns the key.
 */
export function headerKey(header: string): string {
  return header.normalize('NFKC').toLowerCase().replace(/[(（【[][^)）】\]]*[)）】\]]/gu, '').replace(/\s+/gu, '')
}

/**
 * The SKU field a header names.
 * @param header - the header cell.
 * @returns the field, or undefined when no rule recognizes it.
 */
export function suggestField(header: string): SkuField | undefined {
  const key = headerKey(header)
  return (Object.keys(FIELD_NAMES) as SkuField[]).find(field => FIELD_NAMES[field].includes(key))
}

/**
 * The kind an image's name suggests: its file name first, then its folders from the nearest out.
 * @param file - the path under the folder.
 * @returns the hint and the name it came from, or undefined.
 */
function nameHint(file: string): { readonly hint: ImageKind | 'mainFamily'; readonly name: string } | undefined {
  const parts = file.split('/')
  const names = [(parts.at(-1) as string).replace(/\.[^.]+$/u, ''), ...parts.slice(0, -1).reverse()]
  for (const name of names) {
    const found = KIND_HINTS.find(([pattern]) => pattern.test(name))
    if (found !== undefined) return { hint: found[1], name }
  }
  return undefined
}

const near = (ratio: number, target: number): boolean => Math.abs(ratio - target) <= 0.02

/**
 * Sort one image.
 * @param file - the path under the folder.
 * @param facts - its pixels' facts, or undefined when it could not be decoded.
 * @returns the kind, why, and anything the user should check.
 */
export function classifyImage(file: string, facts: ImageFacts | undefined): Omit<ImageEntry, 'file' | 'facts'> {
  const named = nameHint(file)
  const ratio = facts === undefined ? undefined : facts.width / facts.height
  const shape = facts === undefined ? '' : `${String(facts.width)}×${String(facts.height)}`
  const warnings: string[] = []
  if (named !== undefined && named.hint !== 'mainFamily') {
    if (named.hint === 'white' && facts !== undefined && facts.whiteBorderShare < 0.9) warnings.push('名称是白底图，但边缘不是纯白')
    if (named.hint === 'transparent' && facts !== undefined && facts.transparentShare < 0.05) warnings.push('名称是透明图，但图片没有透明区域')
    return { kind: named.hint, reason: `名称「${named.name}」`, warnings }
  }
  if (facts === undefined || ratio === undefined) {
    return { kind: 'unknown', reason: named === undefined ? '没有名称线索，且无法读取像素' : `名称「${named.name}」像主图，但无法读取像素判断比例`, warnings }
  }
  if (named !== undefined) {
    if (near(ratio, 1)) return { kind: 'main', reason: `名称「${named.name}」+ 1:1（${shape}）`, warnings: mainWarnings(facts) }
    if (near(ratio, 0.75)) return { kind: 'main34', reason: `名称「${named.name}」+ 3:4（${shape}）`, warnings }
    return { kind: 'unknown', reason: `名称「${named.name}」像主图，但 ${shape} 既不是 1:1 也不是 3:4`, warnings }
  }
  if (facts.transparentShare >= 0.05) return { kind: 'transparent', reason: `透明背景（${shape}）`, warnings }
  if (near(ratio, 1) && facts.whiteBorderShare >= 0.95) return { kind: 'white', reason: `1:1 纯白背景（${shape}）`, warnings }
  if (near(ratio, 1)) return { kind: 'main', reason: `1:1（${shape}）`, warnings: mainWarnings(facts) }
  if (near(ratio, 0.75)) return { kind: 'main34', reason: `3:4（${shape}）`, warnings }
  if (1 / ratio >= 1.3) return { kind: 'detail', reason: `长竖图（${shape}）`, warnings }
  return { kind: 'unknown', reason: `没有名称线索，${shape} 不是常见的主图或详情比例`, warnings }
}

function mainWarnings(facts: ImageFacts): string[] {
  return facts.width < 800 ? [`1:1 主图建议至少 800×800，这张只有 ${String(facts.width)}×${String(facts.height)}`] : []
}

/**
 * A worksheet's header row and data rows: the first row with at least two filled cells is the header.
 * @param file - the path under the folder.
 * @param sheet - the worksheet's name.
 * @param rows - its cells.
 * @returns the table, or undefined when no row could be a header.
 */
export function tableOf(file: string, sheet: string, rows: readonly (readonly string[])[]): TableEntry | undefined {
  const at = rows.findIndex(row => row.filter(cell => cell !== '').length >= 2)
  if (at < 0) return undefined
  const header = rows[at] as readonly string[]
  const data = rows.slice(at + 1).filter(row => row.some(cell => cell !== ''))
  const columns = header.flatMap((cell, index) => cell === '' ? [] : [{
    header: cell, ...withField(suggestField(cell)), samples: data.slice(0, 3).map(row => row[index] ?? ''),
  }])
  return { file, sheet, columns, rows: data.map(row => header.flatMap((cell, index) => cell === '' ? [] : [row[index] ?? ''])) }
}

function withField(field: SkuField | undefined): { field?: SkuField } {
  return field === undefined ? {} : { field }
}

/**
 * Rows of a CSV file.
 * @param text - the file's text.
 * @returns the cells.
 */
export function readCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { cell += '"'; at++ } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(cell.trim()); cell = '' } else if (char === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = '' } else if (char !== '\r' && char !== '﻿') cell += char
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell.trim()])
  return rows
}

/**
 * Every file under a folder, hidden ones left out, in natural name order.
 * @param folder - the folder.
 * @returns paths under it with `/` separators.
 */
async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile())
    .map(entry => relative(folder, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(file => !file.split('/').some(part => part.startsWith('.')))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

/**
 * Take stock of a material folder.
 * @param folder - the folder.
 * @returns what it holds.
 */
export async function takeInventory(folder: string): Promise<Inventory> {
  const images: ImageEntry[] = []
  const tables: TableEntry[] = []
  const documents: string[] = []
  const videos: string[] = []
  const others: string[] = []
  const unreadable: { file: string; error: string }[] = []
  for (const file of await filesUnder(folder)) {
    const extension = extname(file).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension)) {
      const bytes = await readFile(join(folder, file))
      let facts: ImageFacts | undefined
      try {
        facts = readImage(bytes)
      } catch (error) {
        // An image that cannot be decoded is still sorted by its name, or left for the model.
        unreadable.push({ file, error: (error as Error).message })
      }
      const entry = { file, ...facts === undefined ? {} : { facts }, ...classifyImage(file, facts) }
      const format = imageFormat(bytes)
      if (format !== undefined && !(format === 'png' ? extension === '.png' : extension === '.jpg' || extension === '.jpeg')) {
        images.push({ ...entry, warnings: [...entry.warnings, `扩展名是 ${extension}，实际是 ${format.toUpperCase()}`] })
      } else images.push(entry)
    } else if (extension === '.xlsx' || extension === '.csv') {
      try {
        const sheets = extension === '.csv'
          ? [{ name: '', rows: readCsv(await readFile(join(folder, file), 'utf8')) }]
          : readSheets(await readFile(join(folder, file)))
        for (const sheet of sheets) {
          const table = tableOf(file, sheet.name, sheet.rows)
          if (table !== undefined) tables.push(table)
        }
      } catch (error) {
        // A damaged workbook is named so the user can fix or replace it.
        unreadable.push({ file, error: (error as Error).message })
      }
    } else if (DOCUMENT_EXTENSIONS.has(extension)) documents.push(file)
    else if (VIDEO_EXTENSIONS.has(extension)) videos.push(file)
    else others.push(file)
  }
  return { folder, images: whiteShotsAsMain(images), tables, documents, videos, others, unreadable }
}

/**
 * Several unnamed square images with white borders are product shots on white, the usual main images,
 * rather than one white-background image each.
 * @param images - the sorted images.
 * @returns them, such shots moved to 1:1 main images when there is more than one.
 */
function whiteShotsAsMain(images: ImageEntry[]): ImageEntry[] {
  const unnamed = images.filter(image => image.kind === 'white' && nameHint(image.file) === undefined)
  if (unnamed.length < 2) return images
  return images.map(image => unnamed.includes(image)
    ? { ...image, kind: 'main', reason: `1:1 白底（${String(unnamed.length)} 张没有名称线索的白底图，按主图）`, warnings: [...image.warnings, ...mainWarnings(image.facts as ImageFacts)] }
    : image)
}
