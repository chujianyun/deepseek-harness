# 连接器

[English](connectors.md) | 中文

连接器让桌面版用户把 DSH 连到公司使用的办公平台。连接器和连接器状态等术语定义在[术语表](../glossary.zh.md#connector)中，连接器为什么是平台未经修改的官方 CLI，记录在[连接器 Agent Note](../../.agents/notes/proposed/feature/2026-10-06-connectors-over-official-clis.zh.md) 中。[`@deepseek-ai/dsh-connectors`](../../packages/connector/connectors/README.zh.md) 负责内置连接器及其 CLI；[`@deepseek-ai/dsh-client-ui-connectors`](../../packages/client/ui-connectors/README.zh.md) 渲染连接器页面。

## 安装 CLI

每个 DSH 发行版把每个连接器 CLI 固定为一个版本，并记录每个平台压缩包的大小和 sha256。安装连接器时，按配置的镜像顺序下载本平台的压缩包，从 `<dshHome>/connectors/<id>/downloads/` 续传未完成的下载，只把可执行文件解压到暂存目录，以 `--version` 运行它，只有报告了固定版本时才改名为 `<dshHome>/connectors/<id>/<version>/`，因此中断的安装永远不会被当作已安装。已安装的 CLI 供本机所有租户使用。DSH 从不全局安装 CLI，也从不读取或修改用户自己安装的 CLI 或其配置目录。卸载会删除 `<dshHome>/connectors/<id>`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
