# Issue #14 验收报告：个人版启动、平台账号与后台请求范围

- **工单**：[#14 [个人版 01/09] 个人版启动、平台账号与后台请求范围](https://github.com/chujianyun/deepseek-harness/issues/14)
- **评审基线（review base）**：`dsh-personal` @ `e5d97b461f9f8d2a666afaeb2a665674be781ced`
- **被测修订（integration tip，未含本证据提交）**：`personal-edition/integration` @ `306b2bc389`
- **平台**：macOS (darwin arm64)，Node 26 / pnpm workspace
- **结论**：#14 的实现已合并进 integration 并通过代码评审；本次收尾在其上补齐并复核了验证证据。除下述「验证范围说明」外，各验收标准均有对应通过证据。

## 变更范围（相对基线）

138 个文件，+824 / −4800，移除为主：

- `packages/bundle/base`：移除内置 session 遥测导出器（`cordis.patch.yml`、`package.json`）。
- `packages/bundle/web-app`：移除 Desktop 产品 analytics 组合。
- `apps/desktop`：移除强制更新策略（mandatory-update-policy）及其后台请求、原生产品 analytics 管道、相关 renderer/preload/设置面；保留平台账号与 Welcome 流程。
- `packages/client/ui-message-feedback`：反馈文案改为「记录在会话日志」，不再承诺日志离开设备。
- 新增 `apps/cli/tests/request-isolation.e2e.ts` + `egress-probe.mjs`：受控服务下的请求隔离证据。
- 移除 `snapshots/web/feedback-release/*` 与对应 e2e；新增两条升级指南（telemetry-egress、mandatory-update-policy 移除）。

## 验证矩阵

| 验收标准 | 证据 | 结果 |
|---|---|---|
| 无 Hub 配置/企业登录即可启动、发消息 | `apps/desktop/tests/main-startup.spec.ts`(98)、`welcome-startup/host/window`、`request-isolation.e2e.ts`(5)、Desktop 实启 smoke | 通过 |
| 平台账号/余额/充值与模型授权保留 | `account-backend.spec.ts`(5)、`request-isolation.e2e.ts` 平台 sign-in/profile 用例 | 通过 |
| Welcome/侧边栏/新会话/窗口标题保持个人品牌，无后台动态品牌 | `welcome-renderer.client.spec.tsx`(29)、`desktop-welcome-entry.png` | 通过 |
| 用户配置的模型 API/提供方授权/MCP/联网工具可用 | `request-isolation.e2e.ts` 模型 chat 用例、`bundle/*/tests` 组合测试(5) | 通过 |
| 默认组合不向企业 OAuth/Skill Hub/品牌/遥测/策略发请求；本地设置与版本显示可用 | `request-isolation.e2e.ts`(5，含负向控制)、`base.spec.ts`、`composition.spec.ts` | 通过 |
| 反馈/遥测 UI 不显示无法完成的上传、无未处理错误 | `feedback-dialog.client.spec.tsx`(10)、`feedback-dialog-*.png` | 通过 |
| 启动/配置/账号/请求隔离聚焦测试 + 用户可见快照 | 上述聚焦测试 + `doc-sync` + 移除的 feedback-release 快照 | 通过 |
| macOS Desktop 启动 smoke | 实启 relaunch（见下）+ `desktop-welcome-*.png` + `packaged-runtime-verification`/`installer-packaging` | 通过 |
| 更新使用说明/配置说明、记录不兼容变化 | 两条升级指南 + `doc-sync`(43 gates) | 通过 |

## 执行的检查与结果

- **聚焦单元测试**（vitest，源平面解析）：
  - `packages/bundle/base/tests/base.spec.ts` + `packages/bundle/web-app/tests/composition.spec.ts` → 5 通过。
  - `packages/client/ui-message-feedback/tests/feedback-dialog.client.spec.tsx` + `packages/client/ui-directory-picker-native/tests/client-flow.client.spec.tsx` → 26 通过。
  - Desktop 行为面 10 文件（main-startup 98、welcome-renderer 29、windows-asar-unpack 23、preload-app 19、welcome-window 10、welcome-host 9、update-overlay 6、account-backend 5、welcome-startup 2、update-error-renderer 2）→ 203 通过。
  - Desktop 打包/环境面 9 文件（installed-update-package-content 47、macos-signature 15、windows-sign 13、installed-update-builder 9、windows-update-publisher 6、installer-packaging 6 等）→ 130 通过。
- **请求隔离 e2e**（keyless，`pnpm run test:e2e apps/cli/tests/request-isolation.e2e.ts`）→ 5 通过。受控 loopback 平台/模型服务 + 记录型代理；启动静默、平台 sign-in/取消/profile 读取、模型 chat 均只达受控服务；负向控制证明围栏能捕获 Skill-Hub 类请求。
- **typecheck**：host 面 `tsc -b tsconfig.host.json` 退出 0；client 面 `tsc -b tsconfig.client.json` 退出 0（见下「typecheck 发现」）。
- **doc-sync**：43 gates 通过、0 失败（含两条新升级指南、翻译配对、doc 预算、README/Agent Note 更新）。
- **macOS Desktop 启动 smoke**：`pnpm run start:desktop`（skip-build）实启当前 tip：输出 `No broken requirements found`、绑定 web server（`dsh web: http://127.0.0.1:59464/...`）、对平台发起 `auth_init`(200)，无崩溃；随后已停止进程。补充截图证据：`desktop-welcome-entry.png`（个人品牌 Welcome，登录/添加 API Key，无 Hub 前置）、`desktop-welcome-signin-waiting.png`（平台 sign-in 等待态）。

## typecheck 发现与处置

完整 `pnpm run typecheck` 初次在 client 面失败，报 `TS6059/TS6307`（`packages/test-support/{session-snapshot,llm-replay,loader-smoke}`、`llm/deepseek-llm-api-extensions` 源文件不在 `apps/web` rootDir/文件表内）。

- **根因**：上一轮遗留的**未跟踪**临时取证脚本 `apps/web/tests/issue14-feedback-shot.e2e.ts`（其文件头自述 "Temporary … deleted after the run"）位于 `tests/` 且不在 `apps/web/tsconfig.json` 的 exclude 表内，被 client 面编译并传递引入 host 平面的 `tests/scaffold.ts` → 触发 rootDir 报错。基线无此文件故 client 面为 0 错误；#14 已提交变更未引入该问题。
- **处置**：删除该临时脚本（截图证据已保留在本目录）；随后 host 与 client 面 typecheck 均退出 0。清理了本次 typecheck 在四个包 `src/` 下产生的未跟踪编译副产物（`.js/.d.ts/.map`），未纳入提交。

## 验证范围说明（诚实记录）

- 请求隔离与平台/模型用例使用**受控 loopback 替身**；Desktop 实启的 `auth_init` 为对配置源的初始化调用。二者均**不**作为真实 DeepSeek 平台账号登录的证据；真实账号授权需另行记录。
- Windows 原生运行证据需要相应验证环境，本次未执行，作为发布前验证项保留。
- 全量覆盖与平台矩阵由 CI 负责；本次按 `dsh-pre-push-checks` 选取与变更面匹配的最小证据集，未默认跑全量。

## 证据产物

- `desktop-welcome-entry.png`、`desktop-welcome-signin-waiting.png`：macOS Desktop Welcome 与 sign-in 等待态。
- `feedback-dialog-en.png` / `feedback-dialog-zh.png`（及 `-context` 变体）：反馈对话框本地记录文案。
- 本报告 `report.md`。

## 收尾状态

- 未进行任何 GitHub 外部写入（未开 PR、未评论、未关工单）；PR 正文与工单结论草案另行提供给用户审阅。
- `docs/test-reports/` 已加入 `scripts/translation-pairing.manifest.json` 的 `excluded`（取证报告非用户文档，不参与双语配对）。
- `docs/test-reports/` 已加入 `scripts/verify-repository-references.ts` 的 `excludedPrefixes`：冻结的取证报告需记录确切被测修订，其引用不会随时间失效，与已排除的 `.agents/notes/archived/` 同理；并在 `verify-repository-references.spec.ts` 增补两条排除断言（commit-hash 与 organization-url 各一）。
