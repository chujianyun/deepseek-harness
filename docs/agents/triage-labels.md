# Triage labels

English | [中文](triage-labels.zh.md)

Map the five canonical triage roles to the following tracker labels.

| Canonical role | Tracker label | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an autonomous agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill names a triage role, use its tracker label from this table. Edit the tracker-label column to adopt existing labels. Creating or applying labels follows the external-write authorization rules in [issue tracker rules](issue-tracker.md).
