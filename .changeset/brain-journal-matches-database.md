---
"cognia-next": patch
---

After a headless brain restart, the restored data now matches what the database actually kept: a refused write that was caught no longer comes back as a phantom row, and rows written by a schema upgrade or into a table added while the brain was running are no longer lost.
