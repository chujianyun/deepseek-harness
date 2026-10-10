---
kind: upgrade-guide
description: "随附 profile 不再挂载 OTLP 会话导出器和 Desktop 产品埋点，DSH_TELEMETRY_MODE 与 OTLP 地址环境变量随之失效。"
---

# 随附 profile 移除内置遥测出口

[English](guide.md) | 中文

## 变更

基于 base 的 profile 此前挂载 `session-telemetry-otel` 导出器，将反馈授权后的会话日志前缀通过 OTLP 上传到 `https://dsh-otel-collector.deepseeksvc.com/v1/logs`。`DSH_TELEMETRY_OTLP_URL` 覆盖采集端，`DSH_TELEMETRY_MODE` 选择共享策略，任何非空的 `DSH_TELEMETRY_DISABLED` 都会在启动时禁用该配置行。Desktop profile 还额外挂载产品埋点接收及其 OTLP 导出器，`DSH_PRODUCT_ANALYTICS_OTLP_URL` 可选择隔离的采集端。

随附 profile 现在既不挂载导出器也不挂载埋点接收：默认不再有会话日志 OTLP 上传和 Desktop 产品埋点离开设备。`DSH_TELEMETRY_MODE`、`DSH_TELEMETRY_OTLP_URL` 和 `DSH_PRODUCT_ANALYTICS_OTLP_URL` 不再被读取。自行组合该导出器的自定义 profile 仍支持 `DSH_TELEMETRY_DISABLED`。由用户开关的 DeepSeek 会话日志贡献（**设置 → 通用 → 在使用官方模型 API 时上传 Session Log**）保持不变，提交反馈仍只是本地会话日志记录。

受影响对象包括依赖默认采集端或设置过这些失效变量的部署，以及审计出站流量的评审者。

## 迁移

1. 停止导出无需任何操作，升级即移除。
2. 从启动环境和 CI 中删除 `DSH_TELEMETRY_MODE` 和 `DSH_TELEMETRY_OTLP_URL`；它们不再生效。仅当自定义 profile 挂载该导出器时才保留 `DSH_TELEMETRY_DISABLED`。
3. 如需继续 OTLP 会话日志导出，在 profile 的 `cordis.patch.yml` 中挂载 `@deepseek-ai/dsh-otel` 和 `@deepseek-ai/dsh-session-telemetry-otel`，并显式配置 `exporter.url` 和所需的 `mode`；配置字段见[包 README](../../../../packages/session/session-telemetry-otel/README.zh.md)。`DSH_TELEMETRY_DISABLED` 仍会在启动时禁用该配置行。
4. 通过在会话中记录反馈并观察不再向原采集端发送请求，或检查当前 profile 中不存在 `session-telemetry-otel` 配置行，确认迁移完成。
