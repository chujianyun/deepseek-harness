# 问题跟踪：GitHub

[English](issue-tracker.md) | 中文

本仓库的问题和规格记录在 `chujianyun/deepseek-harness` 的 GitHub Issues 中。使用 `gh` CLI（命令行界面）操作。

## 仓库选择

问题和 PR（Pull Request）命令必须传入 `--repo chujianyun/deepseek-harness`。API 操作使用 `repos/chujianyun/deepseek-harness/...`。本仓库同时配置了 origin 和 upstream 远端，不要依赖 CLI 的默认仓库选择。

## 操作约定

- 使用 `gh issue view` 读取工单，包括评论和标签。
- 使用 `gh issue list` 列出工单，并选择相关状态和标签。需要处理结果时，请求 JSON 字段。
- 使用 `gh issue create` 创建工单。将多行正文保存到临时文件，并传入 `--body-file`。
- 使用 `gh issue comment` 评论；多行文本使用 `--body-file`。
- 使用 `gh issue edit` 添加或移除标签。
- 使用 `gh issue close` 关闭工单。

只读操作可以直接执行。在创建、编辑、评论、添加标签、分配或关闭外部问题或 PR 前，必须获得用户对该操作的明确授权。先准备完整草稿或拟议变更。skill（技能）中的发布指令本身不构成外部写入授权。

## PR 是否纳入分流

**PRs as a request surface: no.**

GitHub 问题与 PR 共用编号。如果编号含义不明确，先使用 `gh pr view` 查询，再回退到 `gh issue view`。

## skill 指令

“发布到问题跟踪系统”表示先为本仓库准备 GitHub 问题，获得用户授权后再创建。“获取相关工单”表示读取问题，包括评论和标签。

## Wayfinding 操作

使用一个标记为 `wayfinder:map` 的 map 问题，包含 Notes、Decisions-so-far 和 Fog 部分。子工单使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。

GitHub 子问题功能可用时，用它关联子工单。否则，将子工单列入 map 的任务列表，并在每个子工单正文顶部添加 `Part of #<map>`。

GitHub 原生问题依赖功能可用时，用它记录阻塞关系；依赖 API 操作需要阻塞工单的数值型数据库 ID，不能使用问题编号或节点 ID。否则，在子工单正文顶部添加 `Blocked by: #<number>`。

可推进的工单是尚未关闭、没有未关闭的阻塞工单且尚未分配给任何人的子工单。按 map 中的顺序选择第一个符合条件的子工单。将工单分配给负责推进的开发者以认领。完成时，评论结果、关闭子工单，并在 map 的 Decisions-so-far 中追加上下文引用。外部写入需要获得上述授权。
