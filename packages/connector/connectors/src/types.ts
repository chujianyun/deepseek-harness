/**
 * Browser-safe wire shapes of the `connectors` Remote namespace: each built-in connector and
 * the install state of its CLI, as the Connectors page renders them.
 *
 * @module @deepseek-ai/dsh-connectors/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No built-in connector has this id. */
    'connectors/not-found': { readonly id: string }
    /** The connector cannot be installed here: it is not supported yet, or its CLI has no build for this platform. */
    'connectors/unavailable': { readonly id: string }
  }
}

/** A built-in connector. */
export type ConnectorId = 'feishu' | 'dingtalk'

/**
 * Where a connector is.
 * - `coming-soon`: DSH does not support it yet.
 * - `unsupported`: its CLI has no build for this platform.
 * - `not-installed`: its CLI is not installed; installing it is offered.
 * - `installing`: its CLI is downloading or being checked.
 * - `disconnected`: its CLI is installed and no platform account is signed in.
 */
export type ConnectorStatus = 'coming-soon' | 'unsupported' | 'not-installed' | 'installing' | 'disconnected'

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
  /** CLI executable name, such as `lark-cli`; null while DSH does not support the connector. */
  readonly cli: string | null
  /** The CLI version this DSH release installs; null while DSH does not support the connector. */
  readonly version: string | null
  /** Archive bytes downloaded out of {@link totalBytes} while installing. */
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Reason of the last failed install; cleared by the next install. */
  readonly error: ConnectorInstallError | null
}

/** Everything the Connectors page shows, in display order. */
export interface ConnectorsState {
  readonly connectors: readonly ConnectorView[]
}
