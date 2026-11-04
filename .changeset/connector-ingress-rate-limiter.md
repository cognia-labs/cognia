---
"cognia-next": patch
---

A headless Host no longer refuses a busy bot's platform webhooks: Slack, Discord, WeChat, QQ, Lark and other webhook deliveries, and the Lark entry's intent polling, now have their own per-source rate limit instead of the sign-in limit of 20 requests a minute.
