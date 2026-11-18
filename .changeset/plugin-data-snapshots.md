---
"cognia-next": minor
---

Plugins can roll back past a data migration: each upgrade that migrates a plugin's data first keeps a snapshot of it, a failed update puts the old data back with the old package, and a rollback asks before restoring the snapshot (or, when none is left, refuses instead of leaving data the older version cannot read). When the snapshot will not fit, you choose between upgrading without one and cancelling, and the plugin's Data tab shows which versions have no snapshot.
