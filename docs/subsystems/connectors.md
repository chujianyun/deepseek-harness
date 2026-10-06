# Connectors

English | [中文](connectors.zh.md)

Connectors let a Desktop user link DSH to the office platforms their company runs on. The vocabulary — connector and connector status — is defined in the [glossary](../glossary.md#connector), and why a connector is the platform's unmodified official CLI is recorded in the [connectors Agent Note](../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.md). [`@deepseek-ai/dsh-connectors`](../../packages/connector/connectors/README.md) owns the built-in connectors and their CLIs; [`@deepseek-ai/dsh-client-ui-connectors`](../../packages/client/ui-connectors/README.md) renders the Connectors page.

## Installing a CLI

Each DSH release pins every connector CLI to one version, with the size and sha256 of each platform's archive. Installing a connector downloads this platform's archive from the configured mirrors in order, resuming a partial download from `<dshHome>/connectors/<id>/downloads/`, unpacks only the executable into a staging directory, runs it with `--version`, and renames it to `<dshHome>/connectors/<id>/<version>/` only when it reports the pinned version, so an interrupted install never looks installed. The installed CLI serves every tenant of the machine. DSH never installs a CLI globally and never reads or changes a CLI the user installed themselves or its configuration directory. Uninstalling deletes `<dshHome>/connectors/<id>`.

## Connecting

The connection belongs to the tenant of the current Hub sign-in. Each tenant gets its own CLI configuration, data, and log directories under `<dshHome>/connectors/<id>/tenants/<tenantId>/`, and every run strips the caller's own lark-cli variables, so the user's own CLI configuration stays untouched. Connecting Feishu follows lark-cli's agent flow: `config init --new` creates the tenant's app in the browser, then `auth login --recommend --json` authorizes the user; each step's address and QR code reach the Connectors page, which opens the address in the browser. A failed or cancelled sign-in that created the app removes it with `config remove`. The connection's [status](../glossary.md#connector-status) comes from `auth status --json --verify` at startup, after an install, when the tenant changes, periodically, and when the page opens. Disconnecting runs `config remove` and deletes the tenant's directory; uninstalling does so for every tenant before deleting the CLI.

## Use in conversations

While a connector is installed and switched on for the current tenant, `dsh-shell-env`'s PATH contributor puts a per-tenant `lark-cli` script ahead of the model shell's `PATH`: connected, it runs the installed CLI with the tenant's directories; disconnected, it refuses and points to the Connectors page; a failing command triggers a health check. While connected, the Skills the CLI embeds join the skill catalog from the `connectors` provider, ahead of the user's own Skill directories. Switching the connector off keeps the sign-in and takes both away.

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
 * Install a connector's CLI in the background; installing an installed, installing, or uninstalling connector changes nothing.
 * @param id - the connector.
 * @returns the state with the install running.
 * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
 */
@Remote async installConnector(id: string): Promise<ConnectorsState>

/**
 * Stop a running install or sign-in, delete every tenant's sign-in, and delete the connector's CLI, downloads included.
 * @param id - the connector.
 * @returns the state with the connector not installed.
 * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
 */
@Remote async uninstallConnector(id: string): Promise<ConnectorsState>

/**
 * Sign the current tenant in to the connector's platform in the background, through the CLI's own
 * agent sign-in; a sign-in under way or a connected connector changes nothing. A tenant without an
 * app first creates one, then the user authorizes; each step's address appears in the view's
 * `login` until the step ends. A failed or cancelled sign-in leaves no app it created behind.
 * @param id - the connector.
 * @returns the state with the sign-in started.
 * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, `connectors/not-installed`, or `hub-account/signed-out`.
 */
@Remote async connect(id: string): Promise<ConnectorsState>

/**
 * Cancel the sign-in under way; an app it created is deleted.
 * @param id - the connector.
 * @returns the state once the sign-in has stopped.
 * @throws RemoteError `connectors/not-found` or `connectors/unavailable`.
 */
@Remote async cancelConnect(id: string): Promise<ConnectorsState>

/**
 * Sign the current tenant out of the connector's platform and delete its sign-in; the CLI stays.
 * @param id - the connector.
 * @returns the state with the connector disconnected.
 * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, or `hub-account/signed-out`.
 */
@Remote async disconnect(id: string): Promise<ConnectorsState>

/**
 * Check every installed connector's connection now, as opening the Connectors page does.
 * @returns the state once the checks have finished.
 */
@Remote async check(): Promise<ConnectorsState>

/**
 * Switch a connector on or off for the current tenant, persisting the profile's list. A switched-off
 * connector stays signed in, but the model gets neither its Skills nor its CLI.
 * @param id - the connector.
 * @param enabled - whether the model may use it.
 * @returns the state once the setting is saved.
 * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, or `hub-account/signed-out`;
 *   Error when mounted without Settings or a profile entry.
 */
@Remote async setEnabled(id: string, enabled: boolean): Promise<ConnectorsState>
```

Source: [`packages/connector/connectors/src/index.ts`](../../packages/connector/connectors/src/index.ts)
<!-- END GENERATED cordis-surface -->
