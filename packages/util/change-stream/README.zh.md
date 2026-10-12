---
description: "为服务的 watch 方法提供状态流：先给出当前状态，之后每次变化都重新读取状态再给出。"
kind: "package-library"
---

# @deepseek-ai/dsh-change-stream

[English](README.md) | 中文

## 概述

`dsh-change-stream` 为服务的 `watch()` 方法提供方法体。保存一组变化回调的服务通过 `changeStream()` 推送自己的状态：先给出当前状态，之后每次变化都重新读取状态再给出，直到调用方的信号或服务的生命周期结束。状态是什么、何时变化仍由服务负责。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

`@Remote({ mode: 'stream' })` 方法在每次变化后推送完整状态视图时，使用 `changeStream()`。若推送的是逐条事件且每条都必须送达，应改用队列。

### 入口

```ts
import { changeStream } from '@deepseek-ai/dsh-change-stream'

@Remote({ mode: 'stream' })
watch(signal: AbortSignal): AsyncIterable<State> {
  return changeStream(this.listeners, () => this.getState(), signal, this.lifetime.signal)
}
```

`listeners` 是服务的变化回调集合，服务在每次变化时逐个调用。确切的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

状态流运行期间向服务的集合加入一个回调，结束时移除。回调只把状态标记为已变化并唤醒状态流，因此在读取或消费某个状态期间到达的多次变化会合并为再读一次：慢的消费方最多落后一个状态。

### 源码导览

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 状态流及其回调与信号的生命周期 |
| [`tests/change-stream.spec.ts`](tests/change-stream.spec.ts) | 首个状态、变化后重读、合并、任一信号结束、清理 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包总览](../README.zh.md) — 各包组共用的其他零依赖基础组件。

-----

<a id="model-experience"></a>
## 模型体验

无，这个进程内辅助函数不注册任何面向模型的内容。

#### KV 缓存影响

这里的内容不进入模型请求，不影响提供方的缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只推送完整状态** — 两次读取之间的中间状态不会送达；需要每次变化的消费方应改用事件队列。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
