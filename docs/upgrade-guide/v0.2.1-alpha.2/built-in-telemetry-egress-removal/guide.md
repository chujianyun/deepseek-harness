---
kind: upgrade-guide
description: "Shipped profiles no longer mount the OTLP session exporter or Desktop product analytics, retiring the DSH_TELEMETRY_MODE and OTLP URL environment switches."
---

# Shipped profiles drop built-in telemetry egress

English | [中文](guide.zh.md)

## Change

Base-backed profiles previously mounted the `session-telemetry-otel` exporter, uploading feedback-authorized Session-log prefixes over OTLP to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`. `DSH_TELEMETRY_OTLP_URL` overrode the collector, `DSH_TELEMETRY_MODE` selected the sharing policy, and any non-empty `DSH_TELEMETRY_DISABLED` disabled the row at launch. Desktop profiles additionally mounted the product analytics intake and its OTLP exporter, whose `DSH_PRODUCT_ANALYTICS_OTLP_URL` selected an isolated collector.

Shipped profiles now mount neither exporter nor the analytics intake: no Session-log OTLP upload and no Desktop product analytics leave the device by default. `DSH_TELEMETRY_MODE`, `DSH_TELEMETRY_OTLP_URL`, and `DSH_PRODUCT_ANALYTICS_OTLP_URL` are no longer read. `DSH_TELEMETRY_DISABLED` is still honored for custom compositions that mount the exporter themselves. The user-switched DeepSeek session-log contribution (**Settings → General → Upload Session Log when using the official model API**) is unchanged, and submitting feedback remains a local Session-log record.

This affects deployments that relied on the default collector or set the retired variables, and reviewers auditing outbound traffic.

## Migration

1. No action is required to stop the exports; upgrading removes them.
2. Remove `DSH_TELEMETRY_MODE` and `DSH_TELEMETRY_OTLP_URL` from launch environments and CI; they no longer have an effect. Keep `DSH_TELEMETRY_DISABLED` only if a custom profile mounts the exporter.
3. To continue OTLP Session-log export, mount `@deepseek-ai/dsh-otel` and `@deepseek-ai/dsh-session-telemetry-otel` through the profile's `cordis.patch.yml` with an explicit `exporter.url` and the desired `mode`; see the [package README](../../../../packages/session/session-telemetry-otel/README.md) for the configuration fields. `DSH_TELEMETRY_DISABLED` continues to disable that row at launch.
4. Confirm the migration by recording feedback in a session and observing no requests to the previous collector, or by inspecting the active profile for the absence of the `session-telemetry-otel` row.
