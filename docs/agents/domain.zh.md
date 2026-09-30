# 领域文档

[English](domain.md) | 中文

工程类 skill（技能）在探索代码库时，应如何消费本仓库的领域文档。

## 探索之前，先读这些

- **[术语表（docs/glossary.md）](../glossary.zh.md)**：项目的受控词汇。
- **[Agent Note](../../.agents/notes/README.zh.md)**：本仓库的决策记录（相当于 ADR）。`.agents/notes/implemented/` 保存描述当前现实的决策，路径编码为 `<class>/yyyy-mm-dd-topic.md`，其中 class 是 `architecture`、`bug-fix`、`feature`、`process`、`simplification`、`testing` 之一。`proposed/` 保存尚未实现的提案，`rejected/` 保存被否决的提案；`archived/` 是冻结的历史，绝不能把它当作当前行为的权威依据。

如果某个主题没有术语表条目或 Agent Note，**静默继续**：不要指出缺失，也不要建议提前创建。条目在术语或决策真正得到解决时才惰性创建：Agent Note 遵循[创建标准](../../.agents/notes/README.zh.md#when-to-write-one)，术语表工作由 `/domain-modeling` skill 驱动（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 进入）。

## 使用术语表的词汇

当你的输出命名一个领域概念时（无论是在 issue 标题、重构提案、假设还是测试名称中），使用 `docs/glossary.md` 中定义的术语。不要漂移术语表明确避免的同义词。

如果你需要的概念还没有收录进术语表，这是一个信号：要么你在发明项目并不使用的说法（重新考虑），要么确实存在空白（记下来交给 `/domain-modeling`）。

## 标出决策冲突

如果你的输出与一份已实现的 Agent Note 冲突，显式地指出来，而不是静默覆盖：

> _与 <topic> 的 Agent Note（`.agents/notes/implemented/<class>/<file>.md`）冲突，但值得重新讨论，因为……_
