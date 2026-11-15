---
"cognia-next": major
---

Data saved by older builds is no longer migrated or read; it is ignored and the current defaults apply. This covers:

- the pre-account `cognia-claude` database
- v1 backup files
- eval runs scored under older versions
- legacy settings fields
- local layouts, panels and preferences saved under older store versions
- old Canvas share links and trace URL keys
- pre-credential-book pairings, which need re-pairing
- credentials still in old locations: provider keys in the settings row, the proxy password, MCP, external-agent, Twin, OCR and Langfuse/Grafana secrets, old Feishu plugin sessions, the Slack `user_token` and the Telegram `webhookSecret`

Re-enter any of these that a feature now reports as missing.
