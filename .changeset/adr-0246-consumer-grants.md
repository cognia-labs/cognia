---
"cognia-next": minor
---

Plugins that use a Host-owned sign-in connection now need their own grant for every operation, reads included, at the exact connection revision; a result that comes back after the connection changed is discarded (ADR-0246). Plugins that read another provider's tokens through `ctx.auth.getSession` still work this release but are audited and warned, and will be denied in the next release.
