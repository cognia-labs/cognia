---
"cognia-next": minor
---

Plugin manifests can now declare auth provider methods, principal kinds, token and revocation endpoints and issuers (ADR-0246), and malformed `authProviders` entries are rejected at validation instead of being accepted silently.
