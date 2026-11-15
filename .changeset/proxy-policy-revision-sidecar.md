---
"cognia-next": patch
---

Changing the network proxy now reaches the agent runtime: an idle runtime is restarted on the new proxy right away, and Settings → Network → General shows whether it still runs on the previous proxy (because a turn was running) with an explicit restart, instead of silently keeping the old proxy until the app restarted.
