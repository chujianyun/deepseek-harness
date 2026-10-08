---
description: "E-commerce accounts section of the dsh Desktop Settings: the account list, adding an account, and following its sign-in in Google Chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-ecommerce-accounts

English | [中文](README.zh.md)

## Summary

Adds an **E-commerce accounts** section to Desktop Settings: the current tenant's [e-commerce accounts](../../../docs/glossary.md#ecommerce-account) grouped by platform, the form that adds one, the sign-in dialog that follows the sign-in in Google Chrome, and each account's details. It reads and acts through the [`ecommerceAccounts` Remote](../../ecommerce/ecommerce-accounts/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser row beside the Host `ecommerce-accounts` row with the same `disabled` condition; the web-app bundle enables both for the `desktop` profile with a configured user center. The plugin contributes only in the Desktop renderer (`dshDesktop` present). It injects `remote.ecommerceAccounts` and registers the section into `settings.section` as `ecommerce-accounts` at order -10 while the Desktop is signed in to the user center, removing it on sign-out. It also adds `ecommerce-accounts.expired` to `shell.overlay`: when an account's sign-in expires, a banner names it (or counts several) for 15 seconds, and its **Sign in again** action opens Settings at the section through `settings/open-section`. Each expiry is announced once, and an account is announced again only after it was signed in; accounts that expire while the banner shows join it.

Opening the section checks every account. Without accounts it shows an **Add the first account** button; otherwise accounts are grouped by platform in collapsible groups with their count, each row showing the store name, the account, the kind, and the status with a colored dot: green signed in, red signed out or expired, yellow when the check timed out, the network was unreachable, or another program holds the account's browser. A buyer account's row adds its pages today against the daily limit, or the hours left of its rest after the platform's risk control, and its details show the same. While there is a buyer account, a field above the list sets how many pages each opens a day (1 to 1000) through `ecommerceAccounts.setBuyerDailyPages()`. While a task of the model uses an account, its status reads **In use by a task**, and signing it in again or deleting it is refused until the task is done. A search box filters by store name or account. When Google Chrome is missing or older than the version DSH needs, a banner above the list says so with a **Get Google Chrome** button.

**Add account** opens a form whose description says the feature works with Google Chrome. The platform is Tmall, Taobao, Pinduoduo, or Douyin shop, and the kind is Merchant account, or Buyer account on Tmall and Taobao. A merchant account needs the store name and account; a buyer account needs only the account, and the form says what DSH limits for it. **Sign in** adds the account and opens its sign-in dialog; an account already added is refused with **This account is already added**. The sign-in dialog says the platform's sign-in page opened in Google Chrome, updates by itself once the account is signed in, and offers **I have signed in** to check at once; it reports a missing or outdated Chrome with **Get Google Chrome**, a browser held by another Chrome, a timed-out sign-in, and a failed check. Once signed in, it shows the account or store name the platform reports, when it reports one.

Selecting an account opens its details — platform, store name, account, kind, status, the name the platform reported, and the last check — with **Sign in again** (or **Sign in**) and **Delete account**, which asks for confirmation and says the account's browser data goes with it. When the platform reports another account name than the one entered (Tmall), or another store name (Pinduoduo, Douyin shop), the sign-in dialog and the details say which account or store is actually signed in and offer **Use the actual account name** or **Use the actual store name**, and **Sign in again**.

-----

<a id="model-experience"></a>
## Model Experience

None, as the section only adds, signs in, and deletes e-commerce accounts.

#### KV Cache effect

No effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buyer accounts on Tmall and Taobao only** — the kind select offers buyer accounts for those platforms.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The section renders the Host's state stream and keeps only the open account, the open dialog, and the last refusal.
