---
"cognia-next": patch
---

Render shared QQ welcome and help surfaces as native Markdown while preserving keyboard callbacks and scene fallbacks. Add a common welcome preview through the help command and regression checks for concurrent onboarding, callback replay, stream isolation and uncertain queued delivery.

Keep C2C stream snapshots and completion on the same native message when QQ reports a zero or small remain_msg_len value, retaining response observations separately from local size limits and passive reply quotas.
