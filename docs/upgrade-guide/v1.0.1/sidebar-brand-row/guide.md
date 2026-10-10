---
kind: upgrade-guide
description: "The enterprise Desktop sidebar shows the MO wordmark instead of the tenant's logo or name and the account launcher drops the company; ui-hub-account no longer exports HubBrandName."
---

# Sidebar brand row shows the MO wordmark

English | [中文](guide.zh.md)

## Change

On Desktop with a user center, the expanded sidebar brand row showed the signed-in tenant's logo or company name, filled by `ui-hub-account`. It now shows the MO WorkAI wire-frame wordmark from `ui-brand-mo`, dark on the light theme and light on the dark one, whatever the tenant; the collapsed rail shows the MO app icon. `ui-hub-account` no longer occupies `sidebar.brand.name` and its `./client` entry no longer exports `HubBrandName` or `HubBrandNameProps`. The sidebar account launcher shows only the employee's name, no longer the company or **No company**; the company shows in Settings → Skill Hub account. The new-session hero still shows the tenant's logo and slogan. Desktop users and code importing `HubBrandName` observe the change.

## Migration

1. Code importing `HubBrandName` or `HubBrandNameProps` from `@deepseek-ai/dsh-client-ui-hub-account/client`: remove the import; the brand row is `ui-brand-mo`'s `MoWordmark`.
2. Keep the `ui-brand-mo` row enabled beside `ui-hub-account`; without it the Desktop sidebar falls back to the shell's fish mark and local-build label.
3. Confirm: start Desktop signed in to a user center and check that the sidebar shows the MO wordmark and the employee's name, Settings → Skill Hub account shows the company, and the new-session page shows the tenant's logo when one is set.
