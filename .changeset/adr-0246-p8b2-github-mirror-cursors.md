---
"cognia-next": patch
---

The GitHub issue mirror no longer misses issues after an interrupted or truncated sync. It resumes from a stored cursor, removes mirror rows only after a complete scan, and backs off on rate limits. Webhook bursts trigger one shared refresh across windows, and an issue deleted or transferred on GitHub is marked "Source removed" right away.
