---
"cognia-next": patch
---

Memory: failed background extraction now retries instead of being recorded as "nothing learned", stale embeddings are re-indexed after a failed text update, temporary mode stops queued compaction, retrying jobs are no longer duplicated or run past their attempt limit, and deleting a conversation stops an in-flight extraction from saving memories.
