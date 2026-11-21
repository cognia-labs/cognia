---
"cognia-next": patch
---

Plans: a sub-workflow step now runs the published workflow version the plan was approved against. Approval is refused, naming the step, when that workflow is not published, and a child run waiting for input pauses the plan instead of failing it. `/plan to-workflow` exports a workflow that runs on its own, without reading or changing the source plan, and explains which step, if any, cannot be exported. Playbook-derived workflows are refreshed from their source skill wherever they are opened or run, not only from Skills. A plan whose run was interrupted by a restart continues and finishes (or pauses on a waiting step) instead of staying "executing" forever.
