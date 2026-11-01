---
"cognia-next": minor
---

Plugin auth providers can be Host-managed (`management: "host"`). They implement only describe, refresh, and optionally exchange and revoke. The Host serves sessions from its connections and keeps the credentials (ADR-0246).
