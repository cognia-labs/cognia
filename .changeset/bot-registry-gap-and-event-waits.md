---
"cognia-next": patch
---

Bots: work accepted while a plugin is still loading or reloading now waits for it instead of being discarded, and is dead-lettered (so Retry still works) only if the Bot never comes back. A run waiting for an event now accepts exactly the reply the queue hands it: another trigger's event, a reply that arrived after the deadline, one an earlier wait already consumed, or a cancelled one no longer wakes it, a reply is never both consumed by the wait and run on its own, and a wait on the short correlation key a Bot declared now matches. The Python SDK's `wait_for_event` takes `trigger_id`.
