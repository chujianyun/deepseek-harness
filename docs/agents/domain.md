# Domain docs

English | [中文](domain.zh.md)

Engineering skills use one glossary and one repository-wide ADR directory. These are agent-consumption rules, not product documentation.

## Before exploring

Read root `GLOSSARY.md`, if present, and relevant decisions in `docs/adr/`, if present. If either is absent, proceed silently; do not propose empty files or create them during setup. Domain modeling creates them when terms or decisions are resolved.

Also consult the [architecture overview](../architecture.md), relevant subsystem and package references, and current [Agent Notes](../../.agents/notes/README.md). Existing Agent Notes own their decisions; do not duplicate them in ADRs. Follow the Agent Note lifecycle rules, and do not treat archived notes as current authority.

## Layout

Use single-context layout:

```text
/
├── GLOSSARY.md
└── docs/
    └── adr/
        ├── 0001-<decision>.md
        └── 0002-<decision>.md
```

Do not create a root `GLOSSARY-MAP.md` or per-package glossaries and ADR directories for this setup.

## Vocabulary

Use glossary terms in issue titles, proposals, hypotheses, and tests. If a term is missing, check the relevant package and subsystem documentation before inventing a synonym. Use the [existing terminology reference](../i18n/terminology.md) for bilingual terminology. Record a real gap for domain modeling rather than filling it speculatively.

## Decision conflicts

When a proposal contradicts an existing ADR or current Agent Note, name the conflicting record and explain why the decision should be reopened. Do not silently override the decision.
