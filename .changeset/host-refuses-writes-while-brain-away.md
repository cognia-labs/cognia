---
"cognia-next": patch
---

A headless Host whose brain is not connected no longer writes chat messages into its fallback store, where they were never reconciled: it now refuses message sends, edits and deletes with a retryable "host unavailable" answer while reads keep working. On a paired phone, deleting a message (or deleting from a message on) during such an outage now says the Host is offline and deletes nothing, instead of removing it locally only for it to come back on the next sync.
