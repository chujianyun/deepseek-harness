/** The Skill that tells the model how to use the e-commerce accounts and which merchant account to pick. */

/** The Skill's name in the skill catalog. */
export const SKILL_NAME = 'ecommerce-accounts'

/** The Skill's catalog description, which the model reads to decide when to load it. */
export const SKILL_DESCRIPTION = 'Read store data with the e-commerce accounts (Tmall, Taobao, Pinduoduo, Douyin shop) the user signed in to in DSH, '
  + 'through the dsh-ecommerce command: list the accounts, pick the merchant account, take over its signed-in Chrome, '
  + 'and read or save what the company confirmed while publishing (store information, categories, table headers, declarations).'

/** The Skill's instructions. */
export const SKILL_CONTENT = `# E-commerce accounts

The user signs e-commerce accounts in to their platforms in DSH Settings → E-commerce accounts (设置 → 电商账号). Each account has its own Google Chrome, which stays signed in. You never get a password or cookie, and you never sign in yourself.

## Commands

Run them in bash:

- \`dsh-ecommerce accounts\` prints the accounts as JSON: \`id\`, \`platform\` (\`tmall\`, \`taobao\`, \`pinduoduo\`, \`doudian\`), \`store\` (merchant accounts), \`account\`, \`kind\` (\`merchant\` or \`buyer\`), and \`status\` (\`signed-in\`, \`signed-out\`, \`signing-in\`, \`checking\`, or \`check-failed\`); a buyer account also has \`pagesToday\` and \`pageLimit\`, and \`cooldownUntil\` while it rests.
- \`dsh-ecommerce browser <id>\` checks with the platform that the account is still signed in, reserves its browser for this bash call, and prints JSON with \`cdpUrl\`, the Chrome DevTools address of its signed-in Chrome. Connect to it in the same bash call, for example with Playwright's \`chromium.connectOverCDP(cdpUrl)\`; the reservation ends when the call ends. Open a tab of your own, close it when you are done, and never close the browser.
- \`dsh-ecommerce buyer [tmall|taobao]\` picks a buyer account for you — signed in, not resting, with the fewest pages opened today — and takes over its browser the same way; its JSON also has \`pagesLeft\`. If none can be used, it says why for each.

## Publishing memory

What the user confirmed while publishing is remembered for the company, so the next publishing task starts from it:

- \`dsh-ecommerce memory\` prints the company's memory as JSON: \`stores\` (store name → \`values\`, field label → value, such as 产地 → 大陆), \`categories\` (product line → platform → \`catId\`, \`categoryPath\`; each platform keeps its own), \`columns\` (table header → SKU field), and \`declarations\` (store name → category id → declaration key → \`text\` and \`confirmedAt\`). Every entry has the time it was saved.
- \`dsh-ecommerce remember <json-file>\` saves entries from a JSON file with any of \`store\` (\`{"name": "…", "values": {"产地": "大陆"}}\`), \`category\` (\`{"line": "…", "platform": "tmall", "catId": "…", "categoryPath": "…"}\`, platform \`tmall\`, \`taobao\`, \`pinduoduo\`, or \`doudian\`; it replaces only that platform's category of the line), \`columns\` (\`{"到手价": "price"}\`, fields \`index\`, \`name\`, \`code\`, \`count\`, \`price\`, \`stock\`, \`unitPrice\`, \`ignore\`), and \`declarations\` (\`{"store": "…", "catId": "…", "confirmed": [{"key": "…", "text": "…"}]}\`). In \`store.values\` and \`columns\` a \`null\` value forgets that entry; \`forget\` (\`{"categories": [{"line": "…", "platform": "…"}], "declarations": [{"store": "…", "catId": "…", "keys": ["…"]}]}\`, without \`keys\` all of that store and category) removes a line's category on that platform and remembered declarations; a bare line name \`"<line>"\` in \`categories\` removes that line on every platform. It prints the memory after the change. If it says the memory file is damaged, tell the user and do not try to rewrite it.
- Remember only what the user gave or confirmed in this conversation, right after they confirm it. Store information is what every item of the store shares (brand, registration numbers, manufacturer, standard, origin, shipping); never remember one item's own attributes, such as its product name or size, as store information. Remember a declaration only after the user confirmed that exact declaration for that store and category; never on their behalf.
- When the user changes a remembered value, remember the new one; when they say a remembered category or a confirmed declaration is wrong, forget it — a category with \`{"line": "…", "platform": "…"}\` for that platform only, so the line's other platforms stay.

## What DSH enforces

DSH watches the browser while your bash call uses it; a page it refuses fails to load with \`net::ERR_BLOCKED_BY_CLIENT\`.

- A merchant account never opens public product or search pages (item.taobao.com, detail.tmall.com, s.taobao.com, list.tmall.com).
- A buyer account opens at most \`pageLimit\` pages a day; every page you open counts, so open only the pages you need.
- When the platform's risk control shows (a slider or verification page), DSH stops the task's pages at once and rests the buyer account (72 hours by default). Stop: do not retry, do not solve the verification, and do not switch to another account. Tell the user.
- Risk control met through the platform's APIs (a call answered with a slider or \`RGV587\`) loads no page, so DSH cannot see it: report it with \`dsh-ecommerce risk <id>\` in the same bash call, which rests that buyer account the same way.

## Choosing a merchant account

- A merchant account reads its own store's back-office data. Never use one to browse public product pages; use \`dsh-ecommerce buyer\` for those.
- If exactly one merchant account of the platform is signed in, use it, and say in your reply which store you used.
- If several are signed in, ask the user which store to use before running anything.
- Use one account per task. If it fails, do not switch to another store.
- If none is signed in, stop and ask the user to add or sign in to the account in DSH Settings → E-commerce accounts (设置 → 电商账号).
- When \`dsh-ecommerce browser\` says the account is signed out, could not be checked, or is in use, stop and tell the user what it said.
- Only read data. Do not change anything on the platform.
`
