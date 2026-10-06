/**
 * What DSH needs from one platform's CLI: how a tenant's runs are isolated, how it signs in and
 * reports its health, the model shell's script, the Skills it ships, and how risky a command is.
 * Each supported connector has one driver; the service holds the install and connection state.
 */
import type { SkillResourceBase } from '@deepseek-ai/dsh-skill'
import type { CliSpec } from './index.ts'
import type { Health, LoginStep, TenantCli, WrapperMode } from './cli.ts'
import type { Assessment } from './risk.ts'
import type { ConnectorId } from './types.ts'

/** A Skill a connector's CLI ships. */
export interface DriverSkill {
  readonly name: string
  readonly description: string
}

/** Where the Skills of one installed CLI version are read from. */
export interface SkillLocation {
  /** The installed CLI version's directory. */
  readonly versionDir: string
  /** A tenant-free CLI for listing, run with the connector's catalog directory. */
  readonly cli: TenantCli
}

/** One platform's CLI, as DSH runs it. */
export interface ConnectorDriver {
  readonly id: ConnectorId
  /** The platform's name in model-facing and audit text, such as `Feishu`. */
  readonly name: { readonly en: string; readonly zh: string }
  /** The CLI release this DSH installs; deployments may restate it through the plugin configuration. */
  readonly spec: CliSpec
  /** The steps a sign-in may take, in order, for the sign-in dialog. */
  readonly steps: readonly LoginStep[]
  /**
   * The environment of a run for one tenant: the process environment without the caller's
   * variables for this CLI, plus the tenant's own directories.
   */
  env(cli: TenantCli): NodeJS.ProcessEnv
  /** Check the tenant's sign-in; anything unreadable is a degraded connection. */
  checkHealth(cli: TenantCli, signal: AbortSignal): Promise<Health>
  /** The steps a sign-in runs, given the health check before it. */
  loginSteps(before: Health): readonly LoginStep[]
  /** Run one sign-in step to completion, reporting the address the user opens once it is known. */
  runLoginStep(cli: TenantCli, step: LoginStep, onAddress: (url: string) => void, signal: AbortSignal): Promise<void>
  /** Draw a QR code of an address as a `data:` URL, or null when it cannot be drawn. */
  qrCode(cli: TenantCli, url: string, signal: AbortSignal): Promise<string | null>
  /** Sign the tenant out and delete its directory. */
  removeTenant(cli: TenantCli): Promise<void>
  /** The model shell's script for one tenant. */
  wrapperScript(cli: TenantCli, mode: WrapperMode, logs: string): string
  /** List the Skills an installed CLI version ships; none when it cannot list them. */
  listSkills(location: SkillLocation, signal: AbortSignal): Promise<DriverSkill[]>
  /** Read one Skill's instructions without its frontmatter; undefined when it cannot. */
  readSkill(location: SkillLocation, name: string, signal: AbortSignal): Promise<string | undefined>
  /** Where the model reads a Skill's files. */
  skillResources(location: SkillLocation, name: string): SkillResourceBase
  /** How risky one command is, from its `--help` text; a command the help says nothing about is unknown. */
  assess(help: string): Assessment
  /** Command words that only read although their help states no risk, such as `auth status`. */
  readonly readOnly: readonly string[]
}
