---
"cognia-next": patch
---

Cleaning up old task history no longer deletes a workspace folder another run is still using. A task that borrowed a folder from a workspace leaves it to that workspace, and archiving a workspace waits until every run working in it has finished. When two runs share a folder, a turn that settles while the other run is starting now always loses Undo, so undoing it can no longer remove the other run's files.
