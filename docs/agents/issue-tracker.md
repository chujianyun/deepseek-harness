# Issue tracker: GitHub

English | [中文](issue-tracker.zh.md)

Issues and specs live in the GitHub Issues for `chujianyun/deepseek-harness`. Use the `gh` CLI.

## Repository selection

Pass `--repo chujianyun/deepseek-harness` to issue and PR commands. For API operations, use `repos/chujianyun/deepseek-harness/...`. This repository has both origin and upstream remotes; do not infer the target from the CLI default.

## Conventions

- Read tickets with `gh issue view`, including comments and labels.
- List tickets with `gh issue list`, selecting the relevant state and labels. Request JSON fields when processing results.
- Create tickets with `gh issue create`. Save multiline bodies to a temporary file and pass `--body-file`.
- Comment with `gh issue comment`; use `--body-file` for multiline text.
- Apply or remove labels with `gh issue edit`.
- Close tickets with `gh issue close`.

Read-only operations may proceed. Before creating, editing, commenting on, labelling, assigning, or closing external issues or PRs, obtain explicit user authorization for the action. Prepare the complete draft or proposed changes first. A skill instruction to publish does not by itself authorize an external write.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and PRs share a number space. Resolve an ambiguous number with `gh pr view`, then fall back to `gh issue view`.

## Skill instructions

“Publish to the issue tracker” means prepare a GitHub issue for this repository, then create it after user authorization. “Fetch the relevant ticket” means read the issue, including comments and labels.

## Wayfinding operations

Use one map issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog sections. Child tickets use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

Link children through GitHub sub-issues when available. Otherwise, list them in the map's task list and put `Part of #<map>` at the top of each child body.

Record blockers through native issue dependencies when available; dependency API operations require the blocker's numeric database ID, not its issue number or node ID. Otherwise, put `Blocked by: #<number>` at the top of the child body.

A frontier ticket is an open child with no open blocker and no assignee. Choose the first eligible child in map order. Claim by assigning the driving developer. Resolve by commenting with the result, closing the child, and appending a context pointer to the map's Decisions-so-far. External writes require the authorization described above.
