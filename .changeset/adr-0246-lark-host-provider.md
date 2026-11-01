---
"cognia-next": minor
---

Built-in Feishu/Lark user authorization is now a Host connection, with real identity (issuer, app, tenant, user). Lark docs, task and bitable sync, and the Lark skills read through it. Plugins that require `auth.feishu` can use it under a consumer grant. Disconnect is fenced against concurrent refresh (ADR-0246).
