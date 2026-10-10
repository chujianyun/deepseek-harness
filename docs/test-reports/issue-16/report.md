# Issue #16 验收报告：Embedding 模型设置与可恢复初始化

- **工单**：[#16 [个人版 03/09] Embedding 模型设置与可恢复初始化](https://github.com/chujianyun/deepseek-harness/issues/16)
- **评审基线（review base）**：`personal-edition/integration` @ `d53159dea8`（合并前 tip）
- **被测修订（integration tip，未含本证据提交）**：`personal-edition/integration` @ `72de679a1f42c3dd1b649d609a3884548bf70fbf`（clean tree）
- **评审修复修订**：`personal-edition/integration` @ `185b09064d`（`72de679a1f` 验收之后的双轴评审修复；复测见「代码评审修复与复测」）
- **平台**：macOS (darwin arm64)，Node 26 / pnpm workspace，Electron 44.7.0（Desktop）
- **结论**：#16 的实现已合并进 integration；本次验收在其上跑通聚焦测试、keyless Web 全旅程 e2e 与真实 macOS Desktop 初始化 smoke。除下述「验证范围说明」外，9 条验收标准均有对应通过证据。

## 变更范围（相对基线 d53159dea8）

90 个文件，+4473 / −85，新增为主：

- 新增 `packages/llm/embedding`：Host embedding 能力（`ctx.embedding`，`@Remote` 命名空间 `embedding`：getState/watch/pauseDownload/startDownload/removeLocalModel/listProviders/addApiModel/removeApiModel；Host-only registerUsage/embed）。`static inject = ['llm']`，不注入企业账号/租户。
- 新增 `packages/util/verified-download`：镜像顺序、`.part` + HTTP Range 断点恢复、size+sha256 校验后 rename。
- 新增 `packages/client/ui-settings-embedding`：设置→嵌入模型（`EmbeddingSection.tsx`、本地模型卡 6 状态、API 嵌入模型列表/添加/删除）。
- 修改 `packages/llm/llm` + `packages/llm/llm-pi-ai`：`routeEndpoint` / `registerEndpointResolver` seam，凭据留在 Host（`resolveApiKey`）。
- 修改 `packages/api/remotes`：`embedding` Remote 客户端投影。
- 修改 `packages/bundle/web-app/cordis.patch.yml`：`embedding` 与 `ui-settings-embedding` 两行 Desktop-only（`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`）。
- 新增 `apps/web/tests/embedding-settings.e2e.ts`：keyless 全旅程（真实浏览器 + loopback 镜像下载 + mock OpenAI）。
- 文档：`docs/capability-seams(.zh).md`、`docs/event-producer-consumer(.zh).md`、`docs/persistence-catalog(.zh).md`、`docs/persistence-schema.json`、`docs/subsystems/*`、各包 README（双语）；`scripts/` doc-graphs / verify-package-readme-model-experience / slot-catalog 同步。

## 验证矩阵

| 验收标准 | 证据 | 结果 |
|---|---|---|
| 1. 不注入企业账号/租户、无 Hub 可用 | `static inject = ['llm']`（无 hubAccount）；`embedding.host.spec.ts` 无 Hub 启动；cordis.patch.yml Desktop-only；web e2e 注释「No Hub or enterprise account is involved」；`desktop-main.png` 个人账号「悟鸣」无 Hub | 通过 |
| 2. 本地模型 6 状态可区分 + 重试/修复入口 | `embedding-section.client.spec.tsx`(12)：missing/downloading/paused/installed/unsupported/damaged + 按钮（下载/暂停/继续/重试/修复/删除）、progressbar `aria-valuenow` | 通过 |
| 3. size+摘要校验、部分恢复、镜像策略、损坏不标可用、失败不阻塞 | `verified-download.spec.ts`(10)：镜像顺序/.part+Range 恢复/size+sha256/损坏不可用；`embedding.host.spec.ts`：loopback 下载/Range 恢复/镜像回退/校验失败/损坏修复；macOS 真实下载 613,527,631 字节 `.part→rename`（rename 即校验通过证据） | 通过 |
| 4. 可配置 API embedding 模型、凭据不发往客户端/企业后台 | `api.ts` POST `<baseURL>/embeddings` 经 `llm.routeEndpoint()`（凭据 Host 侧）；`embedding.host.spec.ts` addApiModel/embed（boot 用 liveConfig+registerEndpointResolver）；web e2e add/remove、`api.models === ['bge-m3']`、embed→`[0.1,0.2,0.3]` | 通过 |
| 5. 平台不支持/本地加载失败/鉴权失败/网络失败/配置缺失 分别可观察 | `embedding.host.spec.ts`：unsupported(plan9-mips)、storage 失败、401/404/502/timeout/cut；均报可观察状态、不制造成功 | 通过 |
| 6. 本地与 API 模型经公开接口产出约定维度向量、独立于知识库 | web e2e `embed('acme-gateway/bge-m3',['x'])`→`[[0.1,0.2,0.3]]`；macOS 本地模型 installed 且 UI 显示「1024 维」（真实 ONNX 加载成功，加载失败会标 damaged） | 通过 |
| 7. 设置重启保留、使用中移除限制/取消/资源释放 | macOS 重启后仍 installed 不重下；`embedding.host.spec.ts` in-use 移除限制/cancel；`embedding-section` in-use 告警 | 通过 |
| 8. 受控下载+API 服务聚焦测试、UI 快照、macOS 初始化 smoke、不把替身当真实下载 | 聚焦 57 + web e2e 1（loopback mirror + mock OpenAI 受控替身）；macOS 真实下载 613MB + onnxruntime 解压 + 重启保持 + CDP 截图；替身与真实下载在「验证范围说明」明确区分 | 通过 |
| 9. 更新下载成本/支持平台/配置/失败恢复文档、类型/构建/文档检查 | 上述 docs 更新；typecheck 退出 0；doc-sync 43/43；dev:desktop 构建「No broken requirements found」 | 通过 |

## 执行的检查与结果

- **聚焦单元测试**（vitest，源平面解析，5 文件 57 通过）：
  - `packages/llm/embedding/tests/embedding.host.spec.ts` → 29 通过（真实 loopback mirror 下载/Range 恢复/镜像回退/校验失败/损坏修复/unsupported/storage 失败；mock OpenAI `/v1/embeddings` 的 addApiModel/embed/401/404/502/timeout/cut/in-use/cancel）。
  - `packages/util/verified-download/tests/verified-download.spec.ts` → 10 通过。
  - `packages/client/ui-settings-embedding/tests/{embedding-section.client.spec.tsx(12), browser-plugin.client.spec.ts(5), embedding-source.client.spec.ts(1)}` → 18 通过。
- **llm + llm-pi-ai seam 回归**：52 文件 1267 通过（routeEndpoint/registerEndpointResolver 拓扑与组合）。
- **keyless Web 全旅程 e2e**（`npx vitest run --config vitest.web.config.ts apps/web/tests/embedding-settings.e2e.ts`）→ 1 通过：真实 chromium 启动 Web scaffold，loopback mirror 后台下载 tiny 模型至 installed，设置→嵌入模型显示「Tiny / 4 维」，添加 API 模型（acme-gateway/bge-m3）经 mock OpenAI 测得 3 维、embed 返回 `[[0.1,0.2,0.3]]`、删除回到空态，无 page error。
- **typecheck**：退出 0。
- **doc-sync**：43 gates 通过、0 失败（含 capability-seams 双语配对、doc 图、persistence 目录、README 模型体验）。
- **构建**：`pnpm run dev:desktop` 构建 embedding / ui-settings-embedding bundle，输出「No broken requirements found」。
- **macOS Desktop 初始化 smoke**（真实模型，非替身）：`pnpm run start:desktop` 实启当前 tip——web server 绑定、无 fatal/unclean；后台真实下载 `model_quantized.onnx` 613,527,631 字节（`.part→rename` 证明 size+sha256 校验通过）并解压 `onnxruntime-1.25.1`；重启后仍 installed 不重下（AC-7）；以 `DSH_DESKTOP_RENDERER_DEBUG_PORT=9333` 经 CDP（playwright-core connectOverCDP）导航 账号菜单→设置→嵌入模型，截图确认本地模型「已安装 / 1024 维 / 删除」、API 嵌入模型空态「去配置模型」，版本徽章 `0.2.1-alpha.2-72de679`（= 被测修订）。

## 代码评审修复与复测

对 `d53159dea8...HEAD` 的双轴评审（Standards / Spec）提出发现项；in-scope 缺陷已在 `185b09064d` 修复并复测，其余为判断题或超出本工单范围，记录如下。

**已修复（in-scope）：**

- 进度溢出（Standards 对称性 / Spec 镜像策略）：`verified-download` 在校验失败丢弃 `.part` 时回退已计字节；`run()` 成功与失败分支对称重算 `received`。复测：`skips a mirror whose bytes fail verification, keeping progress within the total` 断言全程 `receivedBytes <= totalBytes` 且终值相等；`verified-download` 断言校验失败后净字节为 0。
- runtime 损坏死循环（Spec AC2/AC5 最严重项）：`runtimeInstalled` / `installRuntime` 改为要求本平台原生绑定目录存在，缺失即整体重装，而非 `damaged → installed → damaged` 循环。复测：新增 `reinstalls a runtime whose native bindings are gone instead of staying damaged`。
- 凭据缺失直穿 `gateway/internal`（Spec AC5 / 错误处理）：`api.ts` 将 `resolveApiKey()` 的抛出映射为 `embedding/request-failed` 领域码，消息不再泄漏凭据环境变量名。
- API 维度不校验（Spec AC6）：`embed()` 将端点返回维度与测量值比对，不符即报 `embedding/request-failed`。
- ORT 会话不释放（Spec AC7 资源释放）：`OrtSession.release?` + `LocalEmbedder.release()`；移除 / 重下 / dispose 时释放。
- 客户端硬编码顿号（Standards locale-owned）：`inUse` 名单分隔符改由 locale 字典 `list.separator` 提供（zh「、」/ en「, 」）。

**复测（在 `185b09064d` 上）：** 聚焦 5 文件 58 通过（embedding.host 30、verified-download 10、ui-settings-embedding 18）；keyless Web e2e 1 通过；llm + llm-pi-ai 52 文件 1267 通过；typecheck 退出 0；lint 0 错误；doc-sync 43/43。`72de679a1f` 的验收证据保持不变，本节为其后的增量修复与复测。

**记录为判断题 / 超出范围（不修）：**

- `registerUsage` 无生产注册方：唯一消费者（知识库）在本工单 Out of scope；seam 与其测试保留，待知识库工单接入。
- 「更新设置 UI 快照」无 `snapshots/` 产物：仓库快照树仅保留 session-driven 用例（snapshots/AGENTS.md）；设置 UI 的回归面为 client spec + Web e2e + 本报告截图。
- `writeApiModels` 的裸 `Error`：仅在 settings/entryId 缺失的不可达不变量下触发，属「misconfiguration fails loud」，保留。
- `index.ts` 体量（Divergent Change）、`EmbeddingSection` 状态级联（Repeated Switches）、`installRuntime` 参数组（Data Clumps）、dispose 未 await（同步 disposer 约束）：重构类判断题，不改变可观察行为，留待后续简化提案。
- `damaged` 无原因码：状态与修复入口已可观察（AC5 满足）；区分「加载失败 / 文件损坏」的细化留待后续。

## 验证范围说明（诚实记录）

- **受控替身 vs 真实下载的边界**：聚焦测试与 Web e2e 使用 loopback mirror（tiny stand-in 模型/runtime）+ mock OpenAI `/v1/embeddings` 验证下载/恢复/校验/错误路径与 UI；macOS smoke 使用真实 Qwen3-Embedding-0.6B 下载（613MB）与真实 ONNX runtime 加载。二者明确区分，未把替身当成真实模型下载验证。
- **真实第三方 provider 的 API embedding 未实跑**：API 路径以 mock OpenAI 兼容端点验证维度、凭据 Host 侧与错误码（401/404/502/timeout）；真实 provider 授权与计费行为需另行记录。
- **Windows 未运行**：特性为 Desktop-only，本次在 macOS 验证；Windows 原生运行证据作为发布前验证项保留（CI 拥有平台矩阵）。
- 全量覆盖与平台矩阵由 CI 负责；本次按 `dsh-pre-push-checks` 选取与变更面匹配的最小证据集，未默认跑全量。

## 证据产物

- `desktop-main.png`：真实 macOS Desktop 主界面（个人账号「悟鸣」，无 Hub/企业前置）。
- `step-account-menu.png` / `step-settings.png`：CDP 导航 账号菜单→设置 的中间态。
- `embedding-section.png`：设置→嵌入模型页（本地模型 Qwen3-Embedding-0.6B 已安装/1024 维/删除；API 嵌入模型空态/去配置模型；版本徽章 `0.2.1-alpha.2-72de679`）。
- 本报告 `report.md`。

## 收尾状态

- 未进行任何 GitHub 外部写入（未开 PR、未评论、未关工单）；PR 正文与工单结论草案另行提供给用户审阅。
- `docs/test-reports/` 已在 `scripts/translation-pairing.manifest.json` 的 `excluded` 与 `scripts/verify-repository-references.ts` 的 `excludedPrefixes`（沿用 #14）：冻结的取证报告需记录确切被测修订，其引用不会随时间失效。
