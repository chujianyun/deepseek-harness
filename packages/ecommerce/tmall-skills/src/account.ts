/**
 * Take over a Tmall merchant account's signed-in Chrome, and read the company's publishing memory,
 * through DSH's `dsh-ecommerce` command.
 */

import { execFile } from 'node:child_process'
import type { PublishMemory } from '@deepseek-ai/dsh-ecommerce-accounts/src/memory.ts'
import { EXIT, SkillError } from './errors.ts'

/** The account `dsh-ecommerce browser` handed over. */
export interface MerchantBrowser {
  readonly id: string
  /** The store name the user entered. */
  readonly store: string
  readonly account: string
  /** The DevTools address of its signed-in Chrome. */
  readonly cdpUrl: string
}

/** The outcome of running a command. */
export interface EcommerceCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run `dsh-ecommerce` with arguments.
 * @param args - its arguments.
 * @returns how it ended and what it printed.
 */
export function runDshEcommerce(args: readonly string[]): Promise<EcommerceCommandResult> {
  return new Promise((resolve) => {
    execFile('dsh-ecommerce', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr })
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr })
      else resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` })
    })
  })
}

/**
 * Reserve a Tmall merchant account's browser for this bash call, as DSH checks it is still signed in.
 * @param accountId - the account id from `dsh-ecommerce accounts`.
 * @param run - runs `dsh-ecommerce`.
 * @returns the account and its browser address.
 * @throws SkillError with what DSH said when it refuses, signed-out when the account is signed out,
 *   or when the account is not a Tmall merchant account.
 */
export async function takeOverMerchant(accountId: string, run = runDshEcommerce): Promise<MerchantBrowser> {
  const taken = await takeOver(['browser', accountId], run)
  if (taken.platform !== 'tmall' || taken.kind !== 'merchant') {
    throw new SkillError(`账号 ${accountId} 不是天猫商家账号（平台 ${taken.platform}，类型 ${taken.kind}），这个技能只能用天猫商家账号。`, EXIT.usage)
  }
  return { id: taken.id, store: taken.store ?? taken.account, account: taken.account, cdpUrl: taken.cdpUrl }
}

/** The buyer account `dsh-ecommerce buyer` picked. */
export interface BuyerBrowser {
  readonly id: string
  readonly platform: string
  readonly account: string
  /** The DevTools address of its signed-in Chrome. */
  readonly cdpUrl: string
  /** Pages it may still open today. */
  readonly pagesLeft: number
}

/**
 * Let DSH pick a buyer account — signed in, not resting after risk control, fewest pages today — and
 * reserve its browser for this bash call. Merchant accounts are never used.
 * @param run - runs `dsh-ecommerce`.
 * @returns the account, its browser address, and the pages it has left today.
 * @throws SkillError with what DSH said: stopped when no buyer account can be used now (out of pages or
 *   resting), signed-out when the account is signed out, failed otherwise.
 */
export async function takeOverBuyer(run = runDshEcommerce): Promise<BuyerBrowser> {
  const taken = await takeOver(['buyer'], run)
  return { id: taken.id, platform: taken.platform, account: taken.account, cdpUrl: taken.cdpUrl, pagesLeft: taken.pagesLeft ?? 0 }
}

/** What `dsh-ecommerce browser` and `dsh-ecommerce buyer` print. */
interface TakenAccount {
  readonly id: string
  readonly platform: string
  readonly kind: string
  readonly store?: string
  readonly account: string
  readonly cdpUrl: string
  readonly pagesLeft?: number
}

/** Run a `dsh-ecommerce` take-over command and read its answer, or stop with what DSH said. */
async function takeOver(args: readonly string[], run: typeof runDshEcommerce): Promise<TakenAccount> {
  const { code, stdout, stderr } = await run(args)
  if (code === 127) throw new SkillError(`找不到 dsh-ecommerce 命令：这个技能只能在已登录用户中心的 DSH 桌面版里运行。${stderr.trim()}`)
  if (code !== 0) {
    const exit = /account "[^"]*" is signed out/u.test(stderr) ? EXIT.signedOut
      : /no buyer account can be used now|has opened its \d+ pages|is resting after/u.test(stderr) ? EXIT.stopped : EXIT.failed
    throw new SkillError(stderr.trim(), exit)
  }
  return JSON.parse(stdout) as TakenAccount
}

/**
 * Tell DSH that a script met the platform's risk control through its APIs, so the buyer account this
 * bash call took over rests as after a risk page.
 * @param accountId - the buyer account.
 * @param run - runs `dsh-ecommerce`.
 * @returns what to tell the user: until when the account rests, or why DSH could not be told.
 */
export async function reportRisk(accountId: string, run = runDshEcommerce): Promise<string> {
  const { code, stdout, stderr } = await run(['risk', accountId])
  if (code !== 0) return `未能通知 DSH 让这个买家号冷却（${stderr.trim()}），请今天不要再用它。`
  const { account, cooldownUntil } = JSON.parse(stdout) as { account: string; cooldownUntil: string }
  return `DSH 已让买家号 ${account} 冷却到 ${cooldownUntil}，期间不会再被挑选。`
}

export type { PublishMemory }

/**
 * Read the company's publishing memory: store information, categories of product lines, table headers,
 * and confirmed declarations.
 * @param run - runs `dsh-ecommerce`.
 * @returns the memory.
 * @throws SkillError with what DSH said when it cannot be read, such as outside a DSH shell call.
 */
export async function readPublishMemory(run = runDshEcommerce): Promise<PublishMemory> {
  const { code, stdout, stderr } = await run(['memory'])
  if (code === 127) throw new SkillError(`找不到 dsh-ecommerce 命令：读取发品记忆只能在已登录用户中心的 DSH 桌面版里运行。${stderr.trim()}`)
  if (code !== 0) throw new SkillError(`读不到发品记忆：${stderr.trim()}`)
  return JSON.parse(stdout) as PublishMemory
}
