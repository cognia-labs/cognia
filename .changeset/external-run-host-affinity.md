---
"cognia-next": patch
---

An external agent run now stays connected to the Host it started on: switching to another Host no longer cuts off its live output, cancel and approvals still reach it, a run started on this computer keeps working while a remote Host is selected, and a run whose Host stays unreachable ends as "control lost" instead of waiting forever.
