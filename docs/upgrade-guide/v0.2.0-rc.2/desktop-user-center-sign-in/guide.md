---
kind: upgrade-guide
description: "The Desktop product signs in with the company user center only and no longer mounts the DeepSeek account rows."
---

# Desktop signs in with the company user center only

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, the Desktop welcome window signed in with a DeepSeek account or saved an official API key, and the workspace mounted the DeepSeek account rows: `deepseek-account`, `llm-deepseek-account`, `account-controller`, `ui-settings-account`, and `product-analytics`.

The next release opens the Desktop workspace only after a sign-in to the company user center (the `hub-account` row, configured by `DSH_HUB_ORIGIN` and `DSH_HUB_CLIENT_ID`). Without a configured user center, Desktop reports a startup error. The five rows above carry `disabled` for the `desktop` profile (`product-analytics` everywhere); the sidebar account menu is the user-center launcher, and Settings has no Account & balance section, top-up, bonus notice, first-run credit onboarding, or Feedback entry. A stored DeepSeek account grant is left in `$DSH_HOME/.credentials.yaml` and is not read. CLI and Web profiles are unchanged.

## Migration

1. Set `DSH_HUB_ORIGIN` and `DSH_HUB_CLIENT_ID` for the Desktop process to the user center and its registered DSH client; set `DSH_HUB_ALLOW_LOOPBACK_HTTP=1` only for a loopback test center.
2. Configure models under Settings → Models with an API key or a custom route; the DeepSeek account route is no longer available on Desktop.
3. A deployment that still needs a DeepSeek account row on Desktop restates it with `disabled: false` in `$DSH_HOME/profiles/desktop/cordis.patch.yml`; `ui-settings-account` and `ui-hub-account` both fill the single sidebar launcher slot, so enable at most one of them.
4. Confirm: start Desktop, sign in with a company account in the browser, and check that the sidebar shows the employee and company.
