---
"cognia-next": patch
---

Bot runs settle consistently: a run's final output, its terminal state and the `bot.run.completed` / `bot.run.failed` event it owes now commit together, so a retried run reports the attempt that actually succeeded, subscribers hear about failed runs, a host restart no longer leaves a dead-lettered run reading "running", cancelling a dead letter keeps the failed run's history, a run cannot report success for an installation removed while it ran, a time budget stops a handler that ignores cancellation, an installation at its run limit no longer starves other installations, and the 14-day cleanup removes a run's step checkpoints with its delivery.
