# Issue 跟踪器：GitHub

[English](issue-tracker.md) | 中文

本仓库的 issue 和 spec 都保存在 GitHub issue 中。所有操作都使用 `gh` CLI（命令行界面）。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，同时获取标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需附加 `--label` 和 `--state` 过滤器。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加／移除标签**：`gh issue edit <number> --add-label "..."`／`--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库信息从 `git remote -v` 推断；在克隆目录内运行时，`gh` 会自动完成这一步。

## 将 PR 作为 triage 入口

**PR（Pull Request）作为需求入口：否。**_（如果本仓库把外部 PR 当作功能请求处理，则设为 `yes`；`/triage` 会读取这个标志。）_

设为 `yes` 时，PR 与 issue 走相同的标签和状态流程，改用 `gh pr` 系列的对应命令：

- **读取 PR**：`gh pr view <number> --comments`，差异用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（去掉 `OWNER`／`MEMBER`／`COLLABORATOR`）。
- **评论／打标签／关闭**：`gh pr comment`、`gh pr edit --add-label`／`--remove-label`、`gh pr close`。

GitHub 在 issue 和 PR 之间共用一套编号，所以单独的 `#42` 可能是任意一种：先用 `gh pr view 42` 解析，失败后回退到 `gh issue view 42`。

## 当 skill 说「发布到 issue 跟踪器」时

创建一个 GitHub issue。

## 当 skill 说「获取相关工单」时

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是单个 issue，**子** issue 充当工单。

- **Map**：一个带有 `wayfinder:map` 标签的 issue，正文承载 Notes／Decisions-so-far／Fog。`gh issue create --label wayfinder:map`。
- **子工单**：通过 GitHub sub-issue 链接到 map 的 issue（在 sub-issues 端点上调用 `gh api`）。如果未启用 sub-issue，就把子项加入 map 正文的任务列表，并在子项正文顶部写上 `Part of #<map>`。标签：`wayfinder:<type>`（`research`／`prototype`／`grilling`／`task`）。认领后，工单指派给主导的开发者。
- **阻塞关系**：GitHub 的**原生 issue 依赖**是权威的、在 UI 中可见的表示。添加一条边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字 **database id**（用 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，_不是_ `#number` 或 `node_id`）。GitHub 会上报 `issue_dependencies_summary.blocked_by`（仅未关闭的阻塞方，即实时门槛）。依赖功能不可用时，回退为在子项正文顶部写一行 `Blocked by: #<n>, #<n>`。当所有阻塞方都关闭时，工单解除阻塞。
- **Frontier 查询**：列出 map 的未关闭子项（`gh issue list --state open`，限定在 map 的 sub-issue／任务列表范围内），丢弃仍有未关闭阻塞项（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中存在未关闭 issue）或已有指派人的；按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是会话的第一次写操作。
- **了结**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再向 map 的 Decisions-so-far 追加上下文指针（gist 加链接）。
