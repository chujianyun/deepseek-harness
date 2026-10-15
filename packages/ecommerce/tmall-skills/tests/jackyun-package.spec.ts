/**
 * The 吉客云组合装 Skill: every jackyun command it shows names a method the company's Jackyun tool
 * allows, with JSON that parses once its placeholders are filled, and the import file it shows parses too.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const SKILL = new URL('../skills/jackyun-package/SKILL.md', import.meta.url)
/** The methods the 吉客云组合装 setup allows (Spec #234). */
const METHODS = ['erp.storage.goodslist', 'erp-goods.goods.listgoodspackage', 'erp.packagegoods.import']

/** Fill `<…>` placeholders with a sample value. */
const filled = (text: string) => text.replaceAll(/<[^>]+>/gu, 'X1')

describe('jackyun-package Skill', async () => {
  const markdown = await readFile(SKILL, 'utf8')

  it('calls only the allowed methods, with JSON that parses', () => {
    const calls = [...markdown.matchAll(/`jackyun api call --method ([\w.-]+) --json '([^']+)'`/gu)]
    expect(calls.map(([, method]) => method)).toEqual(['erp.storage.goodslist', 'erp-goods.goods.listgoodspackage'])
    for (const [, method, json] of calls) {
      expect(METHODS).toContain(method)
      expect(JSON.parse(filled(json!))).toBeTypeOf('object')
    }
    const imports = [...markdown.matchAll(/`jackyun api call --method ([\w.-]+) --file [^`]+`/gu)].map(([, method]) => method)
    expect(imports).toEqual(['erp.packagegoods.import'])
  })

  it('shows an import file with the fields the import method takes', () => {
    const block = /```json\n([\s\S]+?)```/u.exec(markdown)![1]!
    const file = JSON.parse(filled(block)) as { goodsNo: string; goodsName: string; packageSkuList: Record<string, string>[] }
    expect(Object.keys(file)).toEqual(['goodsNo', 'goodsName', 'skuList', 'packageSkuList'])
    expect(Object.keys(file.packageSkuList[0]!)).toEqual(['skuBarcode', 'goodsAmount', 'sharePrice', 'unitName'])
  })

  it('asks before creating, with no recommended option, and points Windows to --file', () => {
    expect(markdown).toContain('**不要给任何选项标「推荐」/(Recommended)**')
    expect(markdown).toContain('**Windows 上一律用 `--file`**')
    expect(markdown).toContain('--confirm-overwrite')
  })
})
