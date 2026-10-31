---
"cognia-next": patch
---

Plugin data migrations now actually run when a plugin is updated (once, before the new version starts), index changes apply right away, and integration migration records survive log cleanup so a rollback keeps edits you made after migrating.
