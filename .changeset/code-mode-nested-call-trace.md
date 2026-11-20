---
"cognia-next": patch
---

A `run_code` tool card now lists every tool call its program made, in order, with how each one ended (time and result size, or why it failed), live while the program runs and kept after a reload. The agent trace shows those calls as children of the `run_code` call.
