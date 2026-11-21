---
"cognia-next": patch
---

Scheduled tasks hold their state under concurrent work. A run finishing while you pause a task no longer resumes it, two runs finishing together both count, and a finished run can no longer roll back a later run's place in a `maxRuns` budget. A start already taken from the queue now respects a pause, delete or stop that lands before it begins. `cancel-previous` waits for the cancelled run to stop and then starts its replacement even at a host limit of one, and it no longer retries the run it cancelled. A failure to record a successful run's statistics no longer runs the task again. Intervals shorter than one second are refused, because two such slots shared one identity and only one of them ran.
