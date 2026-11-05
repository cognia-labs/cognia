---
"cognia-next": patch
---

Make issue runs dependable from dispatch to settle.

- An issue a run holds can no longer be dragged in or out of In progress from any surface, including the board, bulk edits, the phone and sync. The check now happens inside the write itself.
- Two Run presses can no longer start two runs on the same issue.
- A run the engine refuses is recorded as failed, and the issue stays where it was. Previously an agent task could be left queued and block every later Run, and an agent-team refusal was lost.
- An agent-task run now moves the issue to In progress as soon as the task starts, not after it finishes.
- A Squad run that ends with its task in review now counts as succeeded instead of failed.
- Cancelling a run records "cancelled" rather than "failed", notifies "run cancelled", and returns the issue to the column it came from.
- Settling a run is now a single write.
- At startup, issues an interrupted settle left stuck in In progress are moved on.
