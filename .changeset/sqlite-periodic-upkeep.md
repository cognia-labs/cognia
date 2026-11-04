---
"cognia-next": patch
---

A headless brain on the SQLite store no longer stalls every 2,000 writes: the periodic upkeep now only hands the WAL file's space back, and the full verified rewrite runs when the schema changes, on explicit compaction and at every open.
