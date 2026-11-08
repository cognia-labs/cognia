---
"cognia-next": patch
---

Bots with a desktop event trigger now fire on their own: the desktop subscribes the UI automation watcher for the `desktop.<kind>` types an enabled Bot listens for, instead of only passing events along when a workflow also matched. Pet lifecycle events (level up, evolved, achievement unlocked, unwell) now reach Bots as `desktop.pet.<kind>` events.
