---
"cognia-next": minor
---

Issue sync no longer drops remote changes after a failed or interrupted sync. Each binding keeps a stored cursor and syncs page by page. When a GitHub issue, Lark task or Bitable record is deleted or leaves the synced container, its issue is kept and shows "Source removed". Two syncs importing the same item no longer create duplicates, and rate limits pause syncing instead of failing it.
