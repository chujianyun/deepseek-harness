/** Terms, chunking, document readers, and the per-base index. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chunkText, estimateTokens, unescapeSeparator } from '../src/chunk.ts'
import { MAX_LISTED_SKIPPED, scanFolder } from '../src/folder.ts'
import { pageToMarkdown } from '../src/page.ts'
import ExcelJS from 'exceljs'
import { isSupported, readDocument } from '../src/readers.ts'
import { BaseStore } from '../src/store.ts'
import { matchExpression, terms } from '../src/terms.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-unit-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('terms', () => {
  it('splits Han runs into characters and pairs, and other text into lowercase words', () => {
    expect(terms('年假 Policy v2！⼯作')).toEqual(['年', '假', '年假', 'policy', 'v2', '工', '作', '工作'])
    expect(matchExpression('年假几天')).toBe('"年" OR "假" OR "几" OR "天" OR "年假" OR "假几" OR "几天"')
    expect(matchExpression('？！')).toBeUndefined()
  })
})

describe('chunking', () => {
  const smart = (size: number, overlap: number, separator = '\\n\\n') => ({ size, overlap, strategy: 'structured' as const, separator })
  const delimited = (size: number, overlap: number, separator: string) => ({ size, overlap, strategy: 'delimiter' as const, separator })

  it('estimates one token per Han character and one per four other characters', () => {
    expect(estimateTokens('年假')).toBe(2)
    expect(estimateTokens('annual leave')).toBe(3)
    expect(estimateTokens('  ')).toBe(0)
    expect(unescapeSeparator('\\n\\t\\r\\\\|')).toBe('\n\t\r\\|')
  })

  it('keeps every chunk within the size and repeats the overlap at the start of the next', () => {
    const text = Array.from({ length: 12 }, (_, index) => `第${String(index)}条规定的内容。`).join('')
    const chunks = chunkText(text, smart(30, 10))
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(30)
    // Each chunk ends at a sentence and the next one starts with text from its end.
    expect(chunks[0]!.endsWith('。')).toBe(true)
    expect(chunks[1]!.startsWith('第3条')).toBe(true)
    expect(chunks[0]!.endsWith('第3条规定的内容。')).toBe(true)
    expect(chunks.join('')).toContain('第11条规定的内容。')
    expect(chunkText(text, smart(30, 0)).join('')).toBe(text)
  })

  it('ends smart chunks at Markdown structure, before code fences, and never after a heading', () => {
    const doc = ['# 第一章', '一'.repeat(50) + '。', '## 第二章', '二'.repeat(50) + '。', '### 第三章', '三'.repeat(50) + '。'].join('\n')
    expect(chunkText(doc, smart(62, 0)).map(chunk => chunk.split('\n')[0])).toEqual(['# 第一章', '## 第二章', '### 第三章'])
    const spaced = ['# 第一章', '', '一'.repeat(50) + '。', '', '## 第二章', '', '二'.repeat(50) + '。'].join('\n')
    expect(chunkText(spaced, smart(60, 0)).every(chunk => !/#.*$/u.test(chunk.split('\n').filter(line => line !== '').at(-1)!))).toBe(true)
    const code = '前'.repeat(30) + '。\n```\n' + Array.from({ length: 30 }, (_, index) => `line${String(index)}`).join('\n') + '\n```\n尾'
    const chunks = chunkText(code, smart(35, 0))
    expect(chunks[0]).toBe('前'.repeat(30) + '。')
    expect(chunks[1]!.startsWith('```')).toBe(true)
    // A rule, a list item, a blank line, and a plain line end chunks too; text with no break is cut hard.
    expect(chunkText('甲'.repeat(10) + '\n---\n' + '乙'.repeat(10), smart(13, 0))).toEqual(['甲'.repeat(10) + '\n---', '乙'.repeat(10)])
    expect(chunkText('甲'.repeat(10) + '\n\n' + '乙'.repeat(10), smart(13, 0))).toEqual(['甲'.repeat(10), '乙'.repeat(10)])
    expect(chunkText('甲'.repeat(10) + '\n- 项目一\n' + '乙'.repeat(10), smart(13, 0))[0]).toBe('甲'.repeat(10) + '\n- 项目')
    expect(chunkText('一二三四五六七八九十甲乙丙', smart(5, 0))).toEqual(['一二三四五', '六七八九十', '甲乙丙'])
    // The separator is one more paragraph-level break.
    expect(chunkText('甲'.repeat(10) + '|' + '乙'.repeat(10), smart(13, 0, '|'))).toEqual(['甲'.repeat(10) + '|', '乙'.repeat(10)])
    expect(chunkText('\n\n  \n\n', smart(10, 0))).toEqual([])
    // A blank line beats a nearer sentence end; an unclosed fence runs to the end of the text.
    expect(chunkText('甲'.repeat(30) + '\n\n乙乙。' + '丙'.repeat(20), smart(40, 0))[0]).toBe('甲'.repeat(30))
    expect(chunkText('前言。\n```\n' + 'code '.repeat(20), smart(8, 0)).length).toBeGreaterThan(1)
  })

  it('ends delimiter chunks at the separator first, then at lines, sentences, and spaces', () => {
    const text = '第一节内容很短|第二节内容也很短|第三节'
    expect(chunkText(text, delimited(10, 0, '|'))).toEqual(['第一节内容很短|', '第二节内容也很短|', '第三节'])
    expect(chunkText('alpha beta gamma delta epsilon zeta', delimited(4, 0, '\\n'))).toEqual(['alpha beta gamma', 'delta epsilon zeta'])
    // Without the separator in the text, the fallback chain still finds sentences.
    expect(chunkText('第一句话很长很长。第二句话也很长很长。', delimited(10, 0, '###'))).toEqual(['第一句话很长很长。', '第二句话也很长很长。'])
    expect(chunkText('第一行的内容\n第二行的内容。', delimited(7, 0, '\\n'))).toEqual(['第一行的内容', '第二行的内容。'])
    // Characters outside the Basic Multilingual Plane are never split in half.
    const astral = '𠀀'.repeat(7)
    expect(chunkText(astral, delimited(3, 0, '|'))).toEqual(['𠀀𠀀𠀀', '𠀀𠀀𠀀', '𠀀'])
    expect(chunkText('𠀀𠀀', delimited(1, 0, '|'))).toEqual(['𠀀', '𠀀'])
    expect(chunkText(astral, delimited(3, 1, '|')).every(chunk => chunk.isWellFormed())).toBe(true)
    // An empty separator is never matched.
    expect(chunkText('abc', delimited(10, 0, ''))).toEqual(['abc'])
  })
})

describe('readers', () => {
  it('reads Word, PDF, Markdown, and text, normalizing compatibility characters', async () => {
    expect(await readDocument(join(FIXTURES, 'annual-leave.docx'))).toContain('每年享有 5 天带薪年假')
    const pdf = await readDocument(join(FIXTURES, 'expense-policy.pdf'))
    expect(pdf).toContain('十五个工作日内报销')
    expect(pdf).toContain('approval from the department')
    expect(await readDocument(join(FIXTURES, 'product-manual.md'))).toContain('## 常见问题')
    const dir = await temp()
    await writeFile(join(dir, 'bom.txt'), '﻿会议纪要')
    expect(await readDocument(join(dir, 'bom.txt'))).toBe('会议纪要')
    await writeFile(join(dir, 'broken.pdf'), 'not a pdf')
    await expect(readDocument(join(dir, 'broken.pdf'))).rejects.toThrow()
  })

  it('reads a workbook row by row, each row with its sheet, row number, and column headers', async () => {
    const dir = await temp()
    const path = join(dir, '商品 规格.xlsx')
    const book = new ExcelJS.Workbook()
    const spec = book.addWorksheet('规格')
    spec.addRow(['型号', '容量', '单价'])
    spec.addRow(['名流 500mg', '12 只', 39.9])
    spec.addRow(['名流 超薄', { formula: 'B2', result: '12 只' }, { formula: 'C2*2', result: 79.8 }])
    spec.mergeCells('A5:B5')
    spec.getCell('A5').value = '合并单元格的说明'
    spec.getCell('C6').value = new Date(Date.UTC(2026, 9, 1))
    spec.getCell('D6').value = { richText: [{ text: '无表头' }, { text: '的列' }] }
    book.addWorksheet('空表')
    book.addWorksheet('只有表头').addRow(['日期', '渠道'])
    await book.xlsx.writeFile(path)
    expect(await readDocument(path)).toBe([
      '# 工作表: 规格',
      '规格 第 2 行: 型号=名流 500mg; 容量=12 只; 单价=39.9',
      '规格 第 3 行: 型号=名流 超薄; 容量=12 只; 单价=79.8',
      '规格 第 5 行: 型号=合并单元格的说明',
      '规格 第 6 行: 单价=2026-10-01; D=无表头的列',
      '',
      '# 工作表: 只有表头',
      '列: 日期、渠道',
    ].join('\n'))
    // A workbook without any cell reads as no text; a file that is no workbook does not read.
    const empty = new ExcelJS.Workbook()
    empty.addWorksheet('Sheet1')
    await empty.xlsx.writeFile(join(dir, 'empty.xlsx'))
    expect(await readDocument(join(dir, 'empty.xlsx'))).toBe('')
    await writeFile(join(dir, 'broken.xlsx'), 'not a workbook')
    await expect(readDocument(join(dir, 'broken.xlsx'))).rejects.toThrow()
  })

  it('accepts only the supported extensions, case-insensitively', () => {
    expect(['a.DOCX', 'b.pdf', 'c.md', 'd.markdown', 'e.txt', 'f.XLSX'].every(isSupported)).toBe(true)
    expect(['f.doc', 'g.png', 'h', 'i.xls'].some(isSupported)).toBe(false)
  })
})

describe('folders', () => {
  it('counts every skipped file but lists only the first ones', async () => {
    const dir = await temp()
    await Promise.all(Array.from({ length: MAX_LISTED_SKIPPED + 5 }, (_, index) => writeFile(join(dir, `${String(index).padStart(4, '0')}.png`), '')))
    await writeFile(join(dir, 'a.md'), '甲')
    const scan = await scanFolder(dir, 1000)
    expect(scan.files.map(file => file.path)).toEqual(['a.md'])
    expect(scan.skipped).toHaveLength(MAX_LISTED_SKIPPED)
    expect(scan.skippedCount).toBe(MAX_LISTED_SKIPPED + 5)
  })
})

describe('web pages', () => {
  it('extracts the article as Markdown with links made absolute, and falls back to the whole body', () => {
    const page = pageToMarkdown(`<html><head><title>年假制度 - 内网</title></head><body><nav><a href="/">首页</a></nav>
      <article><h1>员工年假</h1><p>员工入职满一年后，每年享有 <b>5 天</b>带薪年假；满十年享有 10 天。年假需提前三个工作日申请，经直属主管批准后生效。</p>
      <p>详情见<a href="/hr/policy">人事制度</a>。</p></article><script>alert(1)</script></body></html>`, 'https://intra.example.com/hr/leave')
    expect(page.title).toBe('年假制度 - 内网')
    expect(page.markdown).toContain('每年享有 **5 天**带薪年假')
    expect(page.markdown).toContain('[人事制度](https://intra.example.com/hr/policy)')
    expect(page.markdown).not.toContain('首页')
    expect(pageToMarkdown('<p>short</p>', 'https://a.example/')).toEqual({ title: '', markdown: 'short' })
    expect(pageToMarkdown('', 'https://a.example/')).toEqual({ title: '', markdown: '' })
  })
})

describe('index store', () => {
  const item = (id: string, name: string) => ({ id, name, size: 1, status: 'pending' as const, error: null, chunkCount: 0, addedAt: `2026-10-05T00:00:0${id}.000Z` })

  it('stores items and chunks, searches by vector and keywords, and deletes cleanly', async () => {
    const store = new BaseStore(join(await temp(), 'index.sqlite'))
    store.addItem(item('1', '年假制度.docx'))
    store.addItem(item('2', '报销制度.pdf'))
    store.complete('1', [{ text: '员工每年享有 5 天带薪年假', vector: [1, 0, 0] }, { text: '年假需提前申请', vector: [0.9, 0.1, 0] }])
    store.complete('2', [{ text: '差旅费凭发票报销', vector: [0, 1, 0] }])
    expect(store.items().map(row => [row.name, row.status, row.chunkCount])).toEqual([['年假制度.docx', 'completed', 2], ['报销制度.pdf', 'completed', 1]])
    const hits = store.search([1, 0, 0], '年假', 2, 0)
    expect(hits.map(hit => [hit.itemName, hit.ordinal]).sort()).toEqual([['年假制度.docx', 0], ['年假制度.docx', 1]])
    expect(hits[0]!.score).toBeGreaterThan(0.9)
    // Keywords alone still rank the matching chunk first for a vector pointing elsewhere.
    expect(store.search([0, 0, 1], '发票', 1, 0)[0]!.itemName).toBe('报销制度.pdf')
    expect(store.search([0, 0, 1], '？', 5, 0.5)).toEqual([])
    // A zero vector matches nothing by similarity.
    expect(store.search([0, 0, 0], '', 5, 0.01)).toEqual([])
    store.setStatus('2', 'failed', 'embedding')
    expect(store.items()[1]).toMatchObject({ status: 'failed', error: 'embedding' })
    // A failed item keeps its last chunks searchable.
    expect(store.search([0, 1, 0], '发票', 5, 0)).toHaveLength(3)
    store.deleteItem('1')
    expect(store.items().map(row => row.id)).toEqual(['2'])
    expect(store.search([1, 0, 0], '年假', 5, 0.01)).toEqual([])
    store.close()
  })

  it('leaves an item untouched when replacing its chunks fails', async () => {
    const store = new BaseStore(join(await temp(), 'index.sqlite'))
    store.addItem(item('1', 'a.txt'))
    store.complete('1', [{ text: '原有内容', vector: [1] }])
    expect(() => { store.complete('1', [{ text: '新内容', vector: null as never }]) }).toThrow()
    expect(store.items()[0]).toMatchObject({ status: 'completed', chunkCount: 1 })
    expect(store.search([1], '原有', 5, 0)).toHaveLength(1)
    store.close()
  })
})
