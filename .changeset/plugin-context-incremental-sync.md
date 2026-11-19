---
"cognia-next": minor
---

Plugins can sync external data through `ctx.sync` (`sync:run` permission). The Host keeps the cursor, retries and backs off, and an interrupted sync resumes without skipping or repeating changes. The Feishu calendar plugin uses it: calendar events are no longer published twice after an interrupted sync. Revoking calendar access now reports "consumer grant required" instead of a generic error.
