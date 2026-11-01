---
"cognia-next": patch
---

Host-held OAuth client secrets are now bound to the client (provider + client id + issuer), so several apps under one provider no longer overwrite each other's secret. Ambiguous legacy secrets ask for re-entry instead of guessing (ADR-0246).
