---
kind: upgrade-guide
description: "The enterprise Desktop Session header drops Open In and the More actions menu (Download session log, Feedback, /export); Report a problem is the header's feedback entry."
---

# Enterprise Desktop header keeps only Report a problem

English | [中文](guide.zh.md)

## Change

On Desktop with a user center, the Session header showed an Open In split button (Finder, VS Code, Terminal) and a More actions menu with **Download session log** and **Feedback**, and the composer accepted `/export`. The web-app bundle now leaves `open-in-app`, `ui-open-in-app`, and `session-log-download` out of that composition: the header shows **Report a problem** and the sidebar toggle, the file tree and document preview lose their Open In controls, and `/export` is no longer a command. A problem report can include the Session's conversation for the user center's super administrators instead of a downloaded log. Desktop users observe the change; Web and Desktop without a user center keep all three rows.

## Migration

1. Users who downloaded a Session log for support: send **Report a problem** with **Include this session's conversation** ticked instead.
2. A deployment that wants these controls back on the enterprise Desktop: set `disabled: false` on the `open-in-app`, `ui-open-in-app`, or `session-log-download` rows in the profile's `cordis.patch.yml`.
3. Confirm: start Desktop signed in to a user center, open a Session, and check that the header shows **Report a problem** with no Open In button or More actions menu.
