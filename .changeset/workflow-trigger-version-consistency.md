---
"cognia-next": patch
---

Workflow triggers now follow the published version: event filters, cron schedules and webhooks match what is deployed rather than the saved draft. Pausing a schedule no longer edits the workflow. A plain webhook only answers 2xx once its run is admitted (it carries the run id; a refusal gets a 4xx or 503). Automatic runs report the source "trigger", and a file watch pinned to this Host is armed. A Workflow App's async HTTP run now follows its Run Policy and can run on another Host: the serving Host still checks access, quota and idempotency once, and reports status, events and cancellation through the Host running it.
