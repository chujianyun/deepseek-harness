---
description: "按有序镜像列表可续传地下载文件，并在改名就位前按大小和 sha256 校验。"
kind: "package-reference"
---

# @deepseek-ai/dsh-verified-download

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-verified-download` 从多个镜像中第一个能提供文件的镜像下载一个事先已知大小和 sha256 的文件。字节写入 `<dest>.part`；之后的尝试以 HTTP Range 请求从该长度续传，完成的文件只有在大小和摘要都匹配后才改名为 `<dest>`。在运行时下载固定版本制品的包（本地嵌入模型和连接器 CLI）把它作为直接的库依赖使用，而不是通过 `cordis.yml`。

## 目录

- [使用本包](#use-this-package)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```ts
import { downloadFile } from '@deepseek-ai/dsh-verified-download'

let received = 0
await downloadFile({
  urls: ['https://mirror-a.example/tool.tar.gz', 'https://mirror-b.example/tool.tar.gz'],
  dest: '/tmp/tool.tar.gz',
  size: 13_964_426,
  sha256: '64e856a05c8dfdac5dbecd316766e4b05299f230f54833b674a623df3ac13f1c',
}, (bytes) => { received += bytes }, AbortSignal.timeout(60_000))
```

`downloadFile` 按顺序尝试 `urls`。镜像不可达、HTTP 错误、连接中断以及校验失败的字节都会转到下一个镜像；忽略 Range 的镜像会让文件从头下载，并以负数字节报告丢弃的部分长度。所有镜像都失败时，如果有镜像提供了错误的字节，抛出代码为 `verification` 的 `DownloadError`，否则为 `network`；文件无法写入时立即抛出 `storage`。中止信号会以中止原因拒绝，并保留部分文件供下次尝试。`bytesOnDisk(dest)` 报告已完成或部分文件的长度，`sha256File(path)` 计算文件的哈希。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **跟随重定向时不检查主机** — 完整性由大小和 sha256 校验保证；镜像列表不是允许列表。
- **每次调用一个文件** — 调用方自行安排多个文件的顺序并负责总进度。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口；这个无状态工具不拥有事件流或运行时数据，其行为由单元测试固定。
