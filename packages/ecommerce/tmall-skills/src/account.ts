/**
 * Take over a merchant account's signed-in Chrome, and read the company's publishing memory,
 * by asking DSH what its `dsh-ecommerce` command asks.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { CategoryMemory, PublishMemory } from '@deepseek-ai/dsh-ecommerce-accounts/src/memory.ts'
import type { EcommercePlatform, PublishPlatform } from '@deepseek-ai/dsh-ecommerce-accounts/src/types.ts'
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

const USAGE = 'usage: dsh-ecommerce accounts | dsh-ecommerce browser <account-id> | dsh-ecommerce buyer [tmall|taobao] '
  + '| dsh-ecommerce risk <account-id> | dsh-ecommerce signed-out <account-id> | dsh-ecommerce memory | dsh-ecommerce remember <json-file>'

const OUTSIDE_DSH = 'dsh-ecommerce: e-commerce accounts are only available in a DSH shell call while DSH is signed in to the user center.'

/** The request a `dsh-ecommerce` command makes, or the usage error it prints. */
function requestOf(base: string, args: readonly string[]): { url: string; init?: RequestInit } | undefined {
  // An empty argument is a missing one, as the command's `[ -z "$2" ]` has it.
  const [command, given] = args
  const argument = given === '' ? undefined : given
  switch (command) {
    case 'accounts': case 'memory': return { url: `${base}/${command}` }
    case 'browser': case 'risk': case 'signed-out':
      return argument === undefined ? undefined : { url: `${base}/${command}?id=${encodeURIComponent(argument)}` }
    case 'buyer': return { url: `${base}/buyer?platform=${encodeURIComponent(argument ?? '')}` }
    case 'remember':
      return argument === undefined || !existsSync(argument) || !statSync(argument).isFile() ? undefined
        : { url: `${base}/remember`, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: readFileSync(argument) } }
    default: return undefined
  }
}

/**
 * Do what the `dsh-ecommerce` command with these arguments does, in this process: ask DSH at the
 * address it gave this bash call. No child process is started, so the Windows sandbox, which cannot
 * give a confined child the named pipes of piped stdio, does not stop it.
 * @param args - the command's arguments.
 * @param env - the variables that hold `DSH_ECOMMERCE_URL`.
 * @returns how the command would have ended and what it would have printed: 127 outside a DSH shell
 *   call, 2 for wrong arguments, 1 when DSH refuses or cannot be reached.
 */
export async function runDshEcommerce(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<EcommerceCommandResult> {
  const base = env.DSH_ECOMMERCE_URL
  if (base === undefined || base === '') return { code: 127, stdout: '', stderr: `${OUTSIDE_DSH}\n` }
  const asked = requestOf(base, args)
  if (asked === undefined) return { code: 2, stdout: '', stderr: `${USAGE}\n` }
  try {
    const response = await fetch(asked.url, asked.init)
    const body = `${(await response.text()).replace(/\n+$/u, '')}\n`
    return response.status === 200 ? { code: 0, stdout: body, stderr: '' } : { code: 1, stdout: '', stderr: body }
  } catch (error) {
    // fetch says only "fetch failed"; why the connection failed is its cause.
    const { message, cause } = error as Error
    const why = cause instanceof Error ? `${message}: ${cause.message}` : message
    return { code: 1, stdout: '', stderr: `dsh-ecommerce: ${why}\n` }
  }
}

/** The platforms a merchant skill works with, and their names for the user. */
export const MERCHANT_PLATFORMS = { tmall: '天猫', pinduoduo: '拼多多', doudian: '抖店' } as const

/** A platform a merchant skill works with. */
export type MerchantPlatform = keyof typeof MERCHANT_PLATFORMS

/** The platforms a collection script reads, and their names for the user: the merchant platforms and Yuntai. */
export const COLLECT_PLATFORMS = { ...MERCHANT_PLATFORMS, yuntai: '健康品牌云台' } as const

/** A platform a collection script reads. */
export type CollectPlatform = keyof typeof COLLECT_PLATFORMS

/**
 * Reserve a merchant account's browser for this bash call, as DSH checks it is still signed in.
 * @param accountId - the account id from `dsh-ecommerce accounts`.
 * @param run - runs `dsh-ecommerce`.
 * @param platform - the platform the skill works with.
 * @returns the account and its browser address.
 * @throws SkillError with what DSH said when it refuses, signed-out when the account is signed out,
 *   or when the account is not a merchant account of that platform.
 */
export async function takeOverMerchant(accountId: string, run = runDshEcommerce, platform: CollectPlatform = 'tmall'): Promise<MerchantBrowser> {
  const taken = await takeOver(['browser', accountId], run)
  if (taken.platform !== platform || taken.kind !== 'merchant') {
    const name = COLLECT_PLATFORMS[platform]
    throw new SkillError(`账号 ${accountId} 不是${name}商家账号（平台 ${taken.platform}，类型 ${taken.kind}），这个技能只能用${name}商家账号。`, EXIT.usage)
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
 * Let DSH pick a Tmall or Taobao buyer account — signed in, not resting after risk control, fewest pages today — and
 * reserve its browser for this bash call. Merchant accounts are never used.
 * @param run - runs `dsh-ecommerce`.
 * @returns the account, its browser address, and the pages it has left today.
 * @throws SkillError with what DSH said: stopped when no buyer account can be used now (out of pages or
 *   resting), signed-out when the account is signed out, failed otherwise.
 */
export async function takeOverBuyer(run = runDshEcommerce): Promise<BuyerBrowser> {
  // Tmall and Taobao share one sign-in; a buyer on another platform never reads their pages.
  const taken = await takeOver(['buyer', 'tmall,taobao'], run)
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

/**
 * Tell DSH that the account this bash call took over turned out signed out, so DSH checks it at once
 * and, when the check confirms it, shows it expired instead of handing it over again.
 * @param accountId - the account.
 * @param run - runs `dsh-ecommerce`.
 */
export async function reportSignedOut(accountId: string, run = runDshEcommerce): Promise<void> {
  // DSH out of reach changes nothing about the stop, whose message already tells the user to sign in again.
  await run(['signed-out', accountId])
}

export type { CategoryMemory, EcommercePlatform, PublishMemory, PublishPlatform }

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
