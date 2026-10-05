/** Terms, chunking, document readers, and the per-base index. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chunkText, estimateTokens } from '../src/chunk.ts'
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
  it('estimates one token per Han character and one per four other characters', () => {
    expect(estimateTokens('年假')).toBe(2)
    expect(estimateTokens('annual leave')).toBe(3)
    expect(estimateTokens('  ')).toBe(0)
  })

  it('packs paragraphs into chunks and carries the last ones over as overlap', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `第${String(index)}段内容。`.repeat(3))
    const chunks = chunkText(paragraphs.join('\n\n'), 40, 15)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(40)
    // The second chunk starts with the first chunk's last paragraph.
    expect(chunks[1]!.startsWith(chunks[0]!.split('\n').at(-1)!)).toBe(true)
    expect(chunks.join('\n')).toContain('第5段内容。')
  })

  it('splits an oversized paragraph by sentences, and an oversized sentence by characters', () => {
    const sentences = '第一句话很长很长。第二句话也很长很长。'
    expect(chunkText(sentences, 10, 0)).toEqual(['第一句话很长很长。', '第二句话也很长很长。'])
    expect(chunkText('一二三四五六七八九十甲乙丙', 5, 0)).toEqual(['一二三四五', '六七八九十', '甲乙丙'])
    expect(chunkText('\n\n  \n\n', 10, 0)).toEqual([])
    // A line break inside a long paragraph ends a sentence; the break alone is dropped.
    expect(chunkText('第一行很长很长。\n第二行也很长很长', 9, 0)).toEqual(['第一行很长很长。', '第二行也很长很长'])
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

  it('accepts only the supported extensions, case-insensitively', () => {
    expect(['a.DOCX', 'b.pdf', 'c.md', 'd.markdown', 'e.txt'].every(isSupported)).toBe(true)
    expect(['f.doc', 'g.png', 'h'].some(isSupported)).toBe(false)
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
    expect(store.search([0, 1, 0], '发票', 5, 0)).toHaveLength(2)
    store.deleteItem('1')
    expect(store.items().map(row => row.id)).toEqual(['2'])
    expect(store.search([1, 0, 0], '年假', 5, 0)).toEqual([])
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
