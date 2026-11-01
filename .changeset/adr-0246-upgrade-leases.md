---
"cognia-next": patch
---

Upgrading a plugin that provides a sign-in service now pauses the plugins that depend on it and restores them afterwards, including when the upgrade rolls back, and only one window or Host at a time processes a connection's incoming events, so two copies of Cognia can no longer handle the same webhook twice (ADR-0246).
