---
"cognia-next": minor
---

Feishu Calendar now consumes an `auth.feishu` connection (from the Feishu auth plugin or the built-in Lark connector) under a consumer grant, instead of asking for an App ID and secret. It works on feishu.cn and larksuite.com, and existing accounts migrate automatically. The Feishu-only PII exemption for token refresh is removed (ADR-0246).
