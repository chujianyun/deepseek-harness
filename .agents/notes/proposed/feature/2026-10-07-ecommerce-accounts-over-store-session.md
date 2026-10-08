# Agent Note: E-commerce accounts over resident Chrome profiles and page APIs

Status: proposed

English | [中文](2026-10-07-ecommerce-accounts-over-store-session.zh.md)

## Problem

The e-commerce manager [assistant](../../../../docs/glossary.md#assistant) needs a store's real business data — Alimama ad reports, Business Advisor (SYCM) daily figures, public product pages — and those platforms have no API a store can use for it: the data sits behind a browser sign-in protected by device fingerprinting and risk control. How DSH keeps such sign-ins alive, how a skill reaches the data behind them, and how DSH keeps a scraping account from being banned decide whether this works for more than a day.

## Proposal

An [e-commerce account](../../../../docs/glossary.md#ecommerce-account) is one platform account with its **own Google Chrome user-data directory**, launched from the system Chrome and taken over through CDP. Chrome keeps the sign-in itself; DSH stores no password or cookie.

- **Resident browsers.** A signed-in account's Chrome keeps running headless in the background and survives a DSH restart; DSH reattaches to it. Taobao-family core cookies are mostly session cookies, so a browser that closes after each use loses its sign-in.
- **Sign-in check by the platform's own response.** DSH opens a business page, captures the platform's own sign-in API response, and judges it with a per-platform check table; one retry before a sign-in counts as lost.
- **Page APIs, not UI scripts.** Skills take data by calling the JSON APIs the platform's own pages call (Alimama, SYCM), reusing request templates the page itself sends, and cross-check figures between independent sources before reporting them.
- **Two account types.** A [merchant account](../../../../docs/glossary.md#merchant-account) reads its own store's back office and never opens public product pages; a [buyer account](../../../../docs/glossary.md#buyer-account) only opens public pages.
- **Buyer protection enforced by DSH.** A daily page budget per buyer account, a cool-down after platform risk control, and automatic choice of an available buyer account live in DSH, not in skill instructions.
- **Skills in Node, delivered by Skill Hub.** The first Tmall skills are rewritten from the existing Python into Node scripts run by DSH's own Node, and reach only the tenant that needs them through the [Skill Hub](../../../../docs/glossary.md#skill-hub).

## Alternatives considered

### Why not Accio's RPA DSL and an executor for it?

Accio drives each platform with step-by-step page scripts in its own DSL, run by built-in tools that are not in its files. Those scripts belong to Alibaba and carry no license, so DSH cannot ship them. They also click through pages and often wait fixed times: an audit of 28 Taobao-family scripts found 12 whose waits are 20–44% fixed sleeps, which silently download empty or stale files when an export is slow. The page-API approach skips the clicking entirely and has run daily in production for the same store.

### Why not save cookies or use Playwright's bundled Chromium?

Exported storage state and injected cookies were tried and lose the sign-in within days or trigger a second verification; a bundled Chromium has the wrong fingerprint and stalls on slider checks. A real Chrome with a full user-data directory behaves like a person's own browser.

### Why not keep the Python scripts?

Employees' computers do not reliably have Python and its packages. DSH already ships Node, and the scripts mostly call APIs and parse JSON and spreadsheets, so the rewrite is bounded.

### Why not leave buyer-account limits to the skill instructions?

Two buyer accounts were flagged for identity risk after about 23 pages in a day and then tolerated only about 3. A rule the model may skip once can cost an account, so DSH enforces it.

## Acceptance criteria

- Adding a Tmall merchant account opens the system Chrome on the platform's sign-in page, and after the QR scan the account shows signed in without DSH storing any credential.
- Quitting and restarting DSH leaves a signed-in account signed in.
- A buyer account that reaches its daily page budget or hits risk control is not used again until the budget resets or the cool-down ends, whatever the model asks.
- A merchant account is never handed to a skill that opens public product pages.

## Risks

- **Restarts.** Whether a machine restart forces a new QR scan is unverified; the first ticket measures it and the status shows the truth.
- **Platform changes.** Page APIs, request templates, and the sign-in check table follow the platforms and break when they change.
- **Thresholds are empirical.** The daily page budget and the cool-down come from two accounts' history and may need tuning.
- **Chrome is required.** Without the system Google Chrome, e-commerce accounts do not work.
