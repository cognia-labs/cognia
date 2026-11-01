---
"cognia-next": minor
---

Plugins can contribute issue-sync providers that projects bind to through a schema-generated form, with namespaced, schema-versioned resources that survive disable, migration and backup restore (ADR-0246). `ctx.issues.registerSyncProvider` now requires a `manifest.issueSyncProviders` declaration.
