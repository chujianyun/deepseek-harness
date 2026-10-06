# Connectors

English | [中文](connectors.zh.md)

Connectors let a Desktop user link DSH to the office platforms their company runs on. The vocabulary — connector and connector status — is defined in the [glossary](../glossary.md#connector), and why a connector is the platform's unmodified official CLI is recorded in the [connectors Agent Note](../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.md). [`@deepseek-ai/dsh-connectors`](../../packages/connector/connectors/README.md) owns the built-in connectors and their CLIs; [`@deepseek-ai/dsh-client-ui-connectors`](../../packages/client/ui-connectors/README.md) renders the Connectors page.

## Installing a CLI

Each DSH release pins every connector CLI to one version, with the size and sha256 of each platform's archive. Installing a connector downloads this platform's archive from the configured mirrors in order, resuming a partial download from `<dshHome>/connectors/<id>/downloads/`, unpacks only the executable into a staging directory, runs it with `--version`, and renames it to `<dshHome>/connectors/<id>/<version>/` only when it reports the pinned version, so an interrupted install never looks installed. The installed CLI serves every tenant of the machine. DSH never installs a CLI globally and never reads or changes a CLI the user installed themselves or its configuration directory. Uninstalling deletes `<dshHome>/connectors/<id>`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnectors--connectorsservice"></a>

### `ctx.connectors` — `ConnectorsService`

Host owner of the connectors and of the `connectors` Remote namespace.

```ts cordis-catalog
/**
 * Read every connector card.
 * @returns the connectors in display order.
 */
@Remote getState(): Promise<ConnectorsState>

/**
 * Stream the state.
 * @param signal - stream lifetime.
 * @returns the current state, then every change; download progress at most four times a second.
 */
@Remote({ mode: 'stream' }) async *watch(signal: AbortSignal): AsyncIterable<ConnectorsState>

/**
 * Install a connector's CLI in the background; installing an installed or installing connector changes nothing.
 * @param id - the connector.
 * @returns the state with the install running.
 * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
 */
@Remote async installConnector(id: string): Promise<ConnectorsState>

/**
 * Stop a running install and delete the connector's CLI, downloads included.
 * @param id - the connector.
 * @returns the state with the connector not installed.
 * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
 */
@Remote async uninstallConnector(id: string): Promise<ConnectorsState>
```

Source: [`packages/connector/connectors/src/index.ts`](../../packages/connector/connectors/src/index.ts)
<!-- END GENERATED cordis-surface -->
