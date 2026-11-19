---
"cognia-next": patch
---

A plugin update, rollback, install or uninstall that a paired device asks a Host for now runs through the Host's plugin manager: the plugin is stopped before its package changes and comes back in the state it was in, a disabled plugin stays off, and a desktop Host applies the change at once instead of on its next reload. A staged update commits only at the version the device reviewed, a headless Host no longer turns on every plugin it reconciles, a device moving work checks that the Host installed the versions it reviewed, and a paired phone says a plugin toggle is queued and shows the Host's state once it answers.
