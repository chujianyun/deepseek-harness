# Domain Docs

English | [中文](domain.zh.md)

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **[docs/glossary.md](../glossary.md)**: the project's controlled vocabulary.
- **[Agent Notes](../../.agents/notes/README.md)**: this repo's decision records (the ADR equivalent). `.agents/notes/implemented/` holds decisions describing current reality, path-encoded as `<class>/yyyy-mm-dd-topic.md` with class one of `architecture`, `bug-fix`, `feature`, `process`, `simplification`, `testing`. `proposed/` holds unbuilt proposals and `rejected/` declined ones; `archived/` is frozen history — never treat it as current authority.

If a topic has no glossary entry or Agent Note, **proceed silently**. Don't flag the absence; don't suggest creating them upfront. Entries are created lazily when terms or decisions actually get resolved — Agent Notes follow the [creation criteria](../../.agents/notes/README.md#when-to-write-one), and the `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) drives glossary work.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/glossary.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an implemented Agent Note, surface it explicitly rather than silently overriding:

> _Contradicts the <topic> Agent Note (`.agents/notes/implemented/<class>/<file>.md`), but worth reopening because…_
