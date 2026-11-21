---
"cognia-next": patch
---

Workflow runs interrupted by a restart now continue as the same run: they keep their original trigger, timing, published version and branch choices, no longer wait behind one another or skip a run whose lease outlived the old process, and an admitted run that had not started yet is picked up too. A timed-out step is never retried while it is still running, editor previews no longer start published downstream workflows, an approval granted in time survives a late restart while a late answer is refused, an upstream approval only counts when it was actually approved in that run (each loop item is asked separately and loop bodies are gated too), unpublishing a workflow no longer blocks workflows that merely listen for its completion, one scheduled slot forwarded by another Host runs once, and a run handed to another Host is no longer refused for its idempotency key.
