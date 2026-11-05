---
"cognia-next": patch
---

Usage from turns a Host runs for someone else (an organization member's turns, a paired device's turns) is no longer lost when it cannot be saved: the row is kept and saved again later, including after a restart. When a member's agent reports no input tokens, the Host's own count for that turn is recorded instead, so a member's usage no longer shows far fewer tokens than their organization was charged for.
