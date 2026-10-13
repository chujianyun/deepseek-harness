/**
 * An example collection script, as a skill would carry one: it reads the signed-in Tmall home page's
 * address and the table on it with the shared collection runner.
 */
import { readTable, realCollectDeps, runCollect } from '../src/collect.ts'

/**
 * Run the example.
 * @param argv - `--account <id>`.
 * @returns the exit status.
 */
export function main(argv: readonly string[]): Promise<number> {
  return runCollect(argv, realCollectDeps, {
    platform: 'tmall', usage: '用法：--account <电商账号 id>', timeoutMs: 20_000, attempts: 2,
    read: async (page) => {
      await page.goto('https://www.tmall.com/')
      return { href: await page.evaluate<string>('location.href'), table: await readTable(page, '#report') ?? null }
    },
  })
}
