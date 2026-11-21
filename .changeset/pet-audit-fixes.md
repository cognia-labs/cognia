---
"cognia-next": patch
---

Harden Desktop Pet reliability, privacy boundaries, and workflow usability across local and paired remote surfaces:

- Fence pet chat, speech, proactive triggers, reset, and hatch flows against account switches, lock/unlock, history clears, host switches, and component unmount; route `pet_chat_send` and `pet_soul_generate` through `HostSemantic` receipt policy so private replies are never persisted in companion SQLite receipts and cleared history cannot replay.
- Preserve memory-off pet replies, correlate remote pet chat turns without clock-skew or duplicate-text misattribution, and make item consumption, care progression, activity logging, achievements, rename, and automated XP allowance atomic and serialized.
- Fix chat session focus switches emitting false completions, keep unresolved attention/work states across periodic idle heartbeats, capture batched goal/workflow/twin completions without deletion replays, and isolate bubble auto-clear timers by ownership token.
- Project active Sprite v2 packs from the main window to overlay/popup windows, preserve active skins when deleting remembered inactive Live2D/Sprite assets, add actionable attention reminders and richer full-chat handoffs, register keyboard commands for popup/click-through/position reset, surface `$hatch-pet` readiness in AI Hatch Studio, and update bilingual Desktop Pet subsystem docs.
