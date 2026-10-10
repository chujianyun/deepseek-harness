---
kind: upgrade-guide
description: "Desktop no longer resolves, embeds, or enforces a mandatory update policy; its packaging settings, workflow inputs, and shell test-authentication setting are removed."
---

# Desktop removes the mandatory update policy

English | [中文](guide.zh.md)

## Change

Packaged Desktop previously polled a configured mandatory-update policy service at `/api/v0/check_client_update`, opened a blocking update window on a `40005` decision, and offered Feishu test authentication when the local shell setting allowed it. Packaging read the policy origin and options from `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`, `DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`, and `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` in `.env.windows` or `.env.macos`, and the manual Windows workflow required `policy_origin` plus, for test deployments, `login_origins`. The shell created and read `app.getPath('userData')/desktop/settings.json` with `updates.allowTestAuthPopupWindow`.

Desktop now sends no update-policy requests, and the blocking update window is gone without replacement. Packaging no longer resolves or embeds a policy; the dotenv files reject retired `DSH_DESKTOP_MANDATORY_UPDATE_*` settings as unsupported, and the workflow drops both inputs. The shell settings file is no longer read or created. An older installer manifest that still embeds a policy is ignored. Ordinary update checks, local version display, and installer generation are unchanged.

This affects deployments that packaged Desktop with a policy origin, operators of the manual `windows-package.yml` workflow, and users who enabled test authentication dialogs.

## Migration

1. Delete `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`, `DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`, and `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` from `apps/desktop/.env.windows` and `apps/desktop/.env.macos`; packaging fails while they remain. The current `.env.windows.example` and `.env.macos.example` show the accepted settings.
2. When dispatching the manual Windows workflow, stop supplying `policy_origin` and `login_origins`; only the update feed `deployment` choice remains.
3. Delete `app.getPath('userData')/desktop/settings.json` if it only carries the retired `updates.allowTestAuthPopupWindow` field; the application no longer reads it. Windows uninstallation already removes the file.
4. Confirm the migration by packaging with the cleaned dotenv file; the run succeeds, and the packaged application issues no `/api/v0/check_client_update` requests.
