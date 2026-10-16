/**
 * How a scheduled collection script reads a store's back office: in one bash call it reserves the
 * merchant account's signed-in Chrome with `dsh-ecommerce browser`, reads in a background tab of its
 * own within a time limit, prints one JSON object on stdout, and closes its tab; the reservation ends
 * with the bash call, and Chrome keeps running.
 */

import type { ParseArgsOptionsConfig } from 'node:util'
import { COLLECT_PLATFORMS, takeOverMerchant, type CollectPlatform, type MerchantBrowser } from './account.ts'
import { realDeps, runCli } from './cli.ts'
import { EXIT, parseCommandLine, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import { within } from './publish-submit.ts'

/** What a collection script reaches outside itself; tests replace it. */
export interface CollectDeps {
  readonly takeOver: (accountId: string, platform: CollectPlatform) => Promise<MerchantBrowser>
  /** Tell DSH the account taken over turned out signed out. */
  readonly reportSignedOut: (accountId: string) => Promise<void>
  readonly openPage: (cdpUrl: string) => Promise<Page>
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** The real outside world. */
export const realCollectDeps: CollectDeps = {
  ...realDeps,
  takeOver: (accountId, platform) => takeOverMerchant(accountId, undefined, platform),
}

/** The values of a collection script's options besides `--account`. */
export type CollectValues = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>

/** One collection script: which platform it reads and how. */
export interface Collection<T> {
  /** The platform of the merchant account it takes over. */
  readonly platform: CollectPlatform
  /** The usage line shown with a wrong command line. */
  readonly usage: string
  /** Options besides `--account`, which every collection takes. */
  readonly options?: ParseArgsOptionsConfig
  /** The longest one attempt's reading may take, in milliseconds; running out of time stops the run. */
  readonly timeoutMs: number
  /**
   * How many attempts a failure gets, at least 1. A SkillError — signed out, not ready, risk control, or
   * running out of time, whose reading may still be talking to the platform — is never retried.
   */
  readonly attempts: number
  /**
   * Read the data in a fresh background tab.
   * @param page - the tab, closed after the attempt.
   * @param account - the account taken over.
   * @param values - the options' values.
   * @returns the data, printed as JSON.
   */
  read(page: Page, account: MerchantBrowser, values: CollectValues): Promise<T>
}

/** What a collection prints on stdout. */
export interface Collected<T> {
  readonly platform: CollectPlatform
  readonly accountId: string
  /** The store name the user entered for the account. */
  readonly store: string
  readonly account: string
  readonly data: T
}

/**
 * Run a collection script: take over the account named by `--account`, read in a background tab, and
 * print `{ platform, accountId, store, account, data }` as one JSON line. Each attempt opens its own
 * tab, which is closed when the attempt ends; a failure other than a SkillError is tried again until
 * `attempts` run out, while a reading that runs out of time stops the run. A signed-out stop tells DSH,
 * which shows the account expired.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @param collection - the platform and the reading.
 * @returns the exit status: 0, or a SkillError's own, `failed` once every attempt failed.
 */
export function runCollect<T>(argv: readonly string[], deps: CollectDeps, collection: Collection<T>): Promise<number> {
  return runCli(deps, async () => {
    const { values } = parseCommandLine(argv, { ...collection.options, account: { type: 'string' } }, collection.usage, false)
    const { account: accountId, ...rest } = values
    if (typeof accountId !== 'string' || accountId === '') throw new SkillError(`缺少 --account。\n${collection.usage}`, EXIT.usage)
    const account = await deps.takeOver(accountId, collection.platform)
    const failures: string[] = []
    for (let attempt = 1; attempt <= collection.attempts; attempt++) {
      try {
        const data = await attemptOnce(account, deps, collection, rest)
        const { id, store, account: name } = account
        const collected: Collected<T> = { platform: collection.platform, accountId: id, store, account: name, data }
        return JSON.stringify(collected)
      } catch (error) {
        if (!(error instanceof SkillError)) {
          failures.push(`第 ${String(attempt)} 次：${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (error.exitCode === EXIT.signedOut) await deps.reportSignedOut(account.id)
        throw error
      }
    }
    throw new SkillError(`${COLLECT_PLATFORMS[collection.platform]}采集试了 ${String(collection.attempts)} 次都没成功：\n${failures.join('\n')}`)
  })
}

/** How long closing a tab may take before the attempt's outcome stands without it. */
const CLOSE_TIMEOUT_MS = 5000

/** One attempt in its own tab, closed afterwards; it stops with a SkillError when `timeoutMs` passes first. */
async function attemptOnce<T>(account: MerchantBrowser, deps: CollectDeps, collection: Collection<T>, values: CollectValues): Promise<T> {
  const page = await deps.openPage(account.cdpUrl)
  try {
    const reading = collection.read(page, account, values)
    // A reading that runs out of time fails later, once its tab is closed; the run has already stopped.
    reading.catch((_lateFailure: unknown) => undefined)
    return await within(reading, collection.timeoutMs, `${COLLECT_PLATFORMS[collection.platform]}采集`)
  } finally {
    // A tab that cannot be closed, as when Chrome has gone, does not change what the attempt found.
    await within(page.close(), CLOSE_TIMEOUT_MS, '关闭标签页').catch((_closeFailure: unknown) => undefined)
  }
}

/** A table's text: the header cells, each body row's cells, and each footer row's cells, such as totals. */
export interface TextTable {
  readonly headers: string[]
  readonly rows: string[][]
  readonly footer: string[][]
}

/**
 * Read a table in a document: the header row is the last `thead` row, or else the first body row;
 * `tfoot` rows are the footer. Only the table's own rows and cells count, not those of a table nested
 * in a cell; cells keep their text with whitespace collapsed, and rows without cells are left out.
 * Runs inside the page, so it uses nothing outside its own body.
 * @param document - the page's document.
 * @param selector - CSS selector of the `table`.
 * @returns the table, or null when nothing matches or the match is not a table.
 */
export function readTableIn(document: Document, selector: string): TextTable | null {
  const table = document.querySelector(selector)
  if (table?.tagName !== 'TABLE') return null
  const { tHead, tBodies, tFoot } = table as HTMLTableElement
  const cells = (row: HTMLTableRowElement): string[] => Array.from(row.cells, cell => cell.textContent.replace(/\s+/gu, ' ').trim())
  const rowsOf = (section: HTMLTableSectionElement | null): HTMLTableRowElement[] =>
    section === null ? [] : Array.from(section.rows).filter(row => row.cells.length > 0)
  const body = Array.from(tBodies).flatMap(rowsOf)
  const header = rowsOf(tHead).at(-1) ?? body[0]
  return {
    headers: header === undefined ? [] : cells(header),
    rows: body.filter(row => row !== header).map(cells),
    footer: rowsOf(tFoot).map(cells),
  }
}

/**
 * Read a table on the tab's page with {@link readTableIn}.
 * @param page - the tab.
 * @param selector - CSS selector of the `table`.
 * @returns the table, or undefined when nothing matches.
 */
export async function readTable(page: Page, selector: string): Promise<TextTable | undefined> {
  return await page.evaluate<TextTable | null>(`(${readTableIn.toString()})(document, ${JSON.stringify(selector)})`) ?? undefined
}
