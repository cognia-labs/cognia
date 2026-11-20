---
"cognia-next": patch
---

`run_code` programs now take turns: a conversation runs one program at a time and a Host at most four, a program waits up to 35 seconds for a free slot, and one that cannot get one fails as a retryable "busy" error instead of piling more sandboxes onto the Host.
