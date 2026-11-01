---
"cognia-next": minor
---

The Feishu auth plugin is now a Host-managed provider of `auth.feishu`. It supports user sign-in (PKCE) and bot sign-in (app credentials). The App ID and secret are entered in a Host form and never reach the plugin. Existing sessions migrate automatically, and a Feishu account already connected through the built-in Lark connector is not connected twice (ADR-0246).
