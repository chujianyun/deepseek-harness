---
kind: upgrade-guide
description: "The e-commerce publishing memory keeps a product line's category per platform, changing its file and dsh-ecommerce output."
---

# Publishing memory categories per platform

English | [中文](guide.zh.md)

## Change

`<dshHome>/ecommerce/<tenantId>/publish-memory.json` and the JSON `dsh-ecommerce memory` prints kept `categories` as product line → one category with a `platform` field, so remembering a second platform replaced the first. They now keep product line → platform → `catId`, `categoryPath`, and `updatedAt`. `dsh-ecommerce remember` takes the same `category` input but replaces only that platform's entry, and its `platform` must be `tmall`, `taobao`, `pinduoduo`, or `doudian`; `forget.categories` also takes `{line, platform}`. A file written before is read as each line's saved platform and rewritten in the new form on the next `remember`. Earlier releases read a rewritten file as damaged and refuse it. Affected: tenants using the publish skills, and scripts that read `categories` from the file or command output.

## Migration

1. Upgrade DSH and the publish skills from Skill Hub together; the skills read `categories[<line>][<platform>]`.
2. Change scripts that read `categories[<line>].platform` or `.catId` to read `categories[<line>][<platform>].catId`.
3. Run `dsh-ecommerce memory` in a DSH shell call and confirm each remembered line lists its categories under platform names. Do not run an earlier release on this memory after a `remember`.
