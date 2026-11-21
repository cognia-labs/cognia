---
"cognia-next": patch
---

Accepted scheduled work now survives a restart. A slot the scheduler had claimed but not yet started runs after the app comes back (or is skipped when the task's missed-run policy would skip it) instead of being lost, and a retry that was waiting runs at its time instead of being forgotten. A start waiting behind a running one now has a history row at once; if the task is paused, disabled, expired or moved before it runs, or the app restarts first, that row says so instead of the start vanishing.
