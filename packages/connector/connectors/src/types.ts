/**
 * Browser-safe wire shapes of the `connectors` Remote namespace: each built-in connector, the
 * install state of its CLI, and the signed-in tenant's connection, as the Connectors page renders them.
 *
 * @module @deepseek-ai/dsh-connectors/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A bash call ran connector writes without asking, because the user had always allowed each of
     * them for the signed-in tenant — log-only audit, never in the model transcript. `commands`
     * names them as `<cli> <command words>`, such as `lark-cli im +messages-send`.
     */
    'connectors/always-allowed': {
      callId: ToolCallId
      commands: string[]
    }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No built-in connector has this id. */
    'connectors/not-found': { readonly id: string }
    /** The connector cannot be installed here: its CLI has no build for this platform. */
    'connectors/unavailable': { readonly id: string }
    /** The connector's CLI is not installed, so it cannot connect yet. */
    'connectors/not-installed': { readonly id: string }
  }
}

/** A built-in connector. */
export type ConnectorId = 'feishu' | 'dingtalk'

/**
 * Where a connector is for the signed-in tenant; the colors are the glossary's connector status.
 * - `unsupported`: its CLI has no build for this platform.
 * - `not-installed`: its CLI is not installed; installing it is offered.
 * - `installing`: its CLI is downloading or being checked.
 * - `disconnected` (red): its CLI is installed and no platform account is signed in, the user
 *   disconnected, or the sign-in expired and must be redone.
 * - `connecting`: a sign-in is under way; {@link ConnectorView.login} says where.
 * - `connected` (green): signed in, and the last health check passed.
 * - `degraded` (yellow): signed in, but the last health check failed; {@link ConnectorView.problem} says why.
 */
export type ConnectorStatus =
  | 'unsupported' | 'not-installed' | 'installing' | 'disconnected' | 'connecting' | 'connected' | 'degraded'

/**
 * A sign-in step: creating the tenant's app on the platform (Feishu, when the tenant has none),
 * then authorizing the user.
 */
export type ConnectorLoginStep = 'create-app' | 'authorize'

/** The sign-in under way. */
export interface ConnectorLoginView {
  /** The steps this sign-in takes, in order; one for a platform that signs in with its own app. */
  readonly steps: readonly ConnectorLoginStep[]
  readonly step: ConnectorLoginStep
  /** The address the user opens to finish this step; null until the CLI reports it. */
  readonly url: string | null
  /** A `data:` URL of a QR code of {@link url}; null until drawn, or when it could not be. */
  readonly qrCode: string | null
}

/** Why the last sign-in failed. */
export interface ConnectorLoginError {
  readonly step: ConnectorLoginStep
  /** What the CLI reported. */
  readonly message: string
}

/**
 * Why the last install failed.
 * - `network`: no mirror served the CLI archive.
 * - `verification`: the archive did not match its pinned size and sha256.
 * - `storage`: the CLI could not be written or unpacked.
 * - `launch`: the unpacked CLI did not run or did not report its pinned version.
 */
export type ConnectorInstallError = 'network' | 'verification' | 'storage' | 'launch'

/** One connector card. */
export interface ConnectorView {
  readonly id: ConnectorId
  readonly status: ConnectorStatus
  /** CLI executable name, such as `lark-cli`. */
  readonly cli: string
  /** The CLI version this DSH release installs. */
  readonly version: string
  /** Archive bytes downloaded out of {@link totalBytes} while installing. */
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Reason of the last failed install; cleared by the next install. */
  readonly error: ConnectorInstallError | null
  /** The sign-in under way while `connecting`. */
  readonly login: ConnectorLoginView | null
  /** Why the last sign-in failed; cleared by the next sign-in or a passing health check. */
  readonly loginError: ConnectorLoginError | null
  /** The signed-in platform account's name while `connected`, when the platform reports it. */
  readonly account: string | null
  /** Why the last health check failed while `degraded`. */
  readonly problem: string | null
  /** Whether the current tenant leaves the connector on; off, the model gets neither its Skills nor its CLI. */
  readonly enabled: boolean
  /** The Skills the installed CLI release ships, which reach the model while connected and on. */
  readonly skills: readonly ConnectorSkillView[]
  /**
   * The write commands the current tenant always allows, as command words such as
   * `im +messages-send`; they run without asking. Empty while signed out of the Hub.
   */
  readonly alwaysAllowed: readonly string[]
}

/** A Skill a connector gives the model. */
export interface ConnectorSkillView {
  readonly name: string
  readonly description: string
}

/** Everything the Connectors page shows, in display order. */
export interface ConnectorsState {
  readonly connectors: readonly ConnectorView[]
}
