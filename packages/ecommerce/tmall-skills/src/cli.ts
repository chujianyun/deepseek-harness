/** What both report scripts share: options, taking over the account's browser, writing files, and exit statuses. */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { takeOverMerchant, type MerchantBrowser } from './account.ts'
import { beijingDate, pastDate } from './dates.ts'
import { EXIT, SkillError } from './errors.ts'
import { openPage, type Page } from './page.ts'

/** What a script reaches outside itself; tests replace it. */
export interface Deps {
  readonly takeOver: (accountId: string) => Promise<MerchantBrowser>
  readonly openPage: (cdpUrl: string) => Promise<Page>
  readonly fetchFile: typeof fetch
  readonly now: () => Date
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** The real outside world. */
export const realDeps: Deps = {
  takeOver: accountId => takeOverMerchant(accountId),
  openPage: cdpUrl => openPage(cdpUrl),
  fetchFile: fetch,
  now: () => new Date(),
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

/** A report run's options. */
export interface Options {
  /** The e-commerce account id. */
  readonly account: string
  /** The day, `YYYY-MM-DD`. */
  readonly date: string
  /** The directory the files go to. */
  readonly out: string
}

/** The usage line both scripts print. */
const USAGE = '用法：--account <电商账号 id> [--date YYYY-MM-DD，默认昨天（北京时间）] [--out 输出目录，默认 ./天猫报表]'

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @param now - the moment, for the default date.
 * @returns the options.
 * @throws SkillError with the usage exit status for a wrong command line.
 */
export function parseOptions(argv: readonly string[], now: Date): Options {
  let values: { account?: string; date?: string; out?: string }
  try {
    ({ values } = parseArgs({ args: [...argv], options: { account: { type: 'string' }, date: { type: 'string' }, out: { type: 'string' } } }))
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  if (values.account === undefined || values.account === '') throw new SkillError(`缺少 --account。\n${USAGE}`, EXIT.usage)
  return { account: values.account, date: pastDate(values.date ?? beijingDate(now, 1), now), out: values.out ?? '天猫报表' }
}

/**
 * Run a report and turn its outcome into output and an exit status: the report's text on stdout and
 * 0, or the reason it stopped on stderr and that reason's status.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @param report - makes the report and returns the text to print.
 * @returns the exit status.
 */
export async function runReport(
  argv: readonly string[], deps: Deps, report: (options: Options, deps: Deps) => Promise<string>,
): Promise<number> {
  try {
    deps.stdout(`${await report(parseOptions(argv, deps.now()), deps)}\n`)
    return 0
  } catch (error) {
    if (error instanceof SkillError) {
      deps.stderr(`${error.message}\n`)
      return error.exitCode
    }
    deps.stderr(`失败：${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.failed
  }
}

/**
 * Take over the account's browser, open a tab, and close the tab afterwards.
 * @param options - the run's options.
 * @param deps - the outside world.
 * @param use - reads data in the tab.
 * @returns what `use` returns, and the account.
 */
export async function withMerchantPage<T>(
  options: Options, deps: Deps, use: (page: Page) => Promise<T>,
): Promise<{ readonly account: MerchantBrowser; readonly result: T }> {
  const account = await deps.takeOver(options.account)
  const page = await deps.openPage(account.cdpUrl)
  try {
    return { account, result: await use(page) }
  } finally {
    await page.close()
  }
}

/**
 * Write a report's files next to each other.
 * @param out - the directory, relative to the working directory.
 * @param base - the file name without extension.
 * @param files - extension → contents.
 * @returns the absolute path of each file, in order.
 */
export async function writeFiles(out: string, base: string, files: readonly (readonly [string, string | Uint8Array])[]): Promise<string[]> {
  const dir = resolve(out)
  await mkdir(dir, { recursive: true })
  const paths: string[] = []
  for (const [extension, contents] of files) {
    const path = resolve(dir, `${base}.${extension}`)
    await writeFile(path, contents)
    paths.push(path)
  }
  return paths
}

/**
 * A store name as part of a file name.
 * @param name - the store name.
 * @returns the name with path and reserved characters replaced.
 */
export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/gu, '_')
}
