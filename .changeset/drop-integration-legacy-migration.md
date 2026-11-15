---
"cognia-next": major
---

The plugin integration migration API (`ctx.integrations.migrateLegacy` / `rollbackMigration`) and the manifest field `workflowKindAliases` are removed. Workflows that still use the old GitHub node kinds are no longer rewritten. Integration accounts with no recorded auth-provider owner must be reconnected. Feishu Calendar sync checkpoints from older builds are ignored, so the next sync does a full scan.
