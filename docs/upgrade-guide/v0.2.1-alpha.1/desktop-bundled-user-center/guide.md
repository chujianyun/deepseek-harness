---
kind: upgrade-guide
description: "Desktop packaging requires the user-center origin and DSH client id, which the package now embeds."
---

# Desktop packages embed their user center

English | [中文](guide.zh.md)

## Change

Previously a packaged Desktop read the user center only from `DSH_HUB_ORIGIN` and `DSH_HUB_CLIENT_ID` in its launch environment, so an installed copy started without them failed at startup with `desktop welcome: Web request failed`. Packaging now requires `DSH_DESKTOP_HUB_ORIGIN` and `DSH_DESKTOP_HUB_CLIENT_ID` in `apps/desktop/.env.macos` or `.env.windows` and embeds them in the package; preparation, unsigned, and signed builds stop with `desktop package: DSH_DESKTOP_HUB_ORIGIN requires an HTTPS origin` or `desktop package: DSH_DESKTOP_HUB_CLIENT_ID requires the DSH client id registered in the user center` when either is missing. A launch environment that sets both `DSH_HUB_ORIGIN` and `DSH_HUB_CLIENT_ID` still replaces the embedded pair; setting only one is now refused. A Desktop with neither now shows a startup dialog stating that no user center is configured. Whoever packages Desktop is affected.

## Migration

1. Have the user-center super administrator register a `public` DSH client with the redirect URI `http://127.0.0.1/callback` and the scopes `profile`, `skills:read`, and `skills:write`, and note its client id.
2. Add both settings to the local dotenv file, as in [`.env.macos.example`](../../../../apps/desktop/.env.macos.example):

   ```dotenv
   DSH_DESKTOP_HUB_ORIGIN=https://hub.example.com
   DSH_DESKTOP_HUB_CLIENT_ID=dsh_0123456789abcdef01234567
   ```

3. Package, then launch the installed application without `DSH_HUB_ORIGIN` set: the welcome window offers the user-center sign-in.
