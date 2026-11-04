---
"cognia-next": patch
---

On a multi-user Host, a member's agent turn now keeps that member's brain running until it finishes: long turns are no longer cut off by the idle reaper or by another member's brain taking the slot, member turns count toward the brain's concurrency ceiling, and a Host update waits for them.
