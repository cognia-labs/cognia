---
"cognia-next": minor
---

Signing in to a plugin-provided service now creates a Host-owned connection (ADR-0246): the Host runs the OAuth attempt itself (one-time state, PKCE, issuer-checked authorization URL), lets the provider exchange and describe the account, and stores the result. Reconnecting keeps the same connection only for the same account, adding scopes creates a new connection revision, and a plugin that finds no connection can offer a sign-in prompt.
