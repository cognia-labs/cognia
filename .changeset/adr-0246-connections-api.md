---
"cognia-next": minor
---

Plugins can now use Host-owned sign-in connections through `ctx.auth.connections` (ADR-0246): they see only connections of providers they declare a dependency on, the Host binds the single matching account or lets you pick one once per plugin, and a plugin asks for access with a grant prompt that lists the exact read and write operations it wants.
