---
"cognia-next": patch
---

`cognia-agent provider` reports now open with who answered them instead of a `Transport:` line that named the running desktop even when it had no part in the answer. `models`, `balance`, `limits` and `usage` answer from this machine and no longer look for a desktop or server first, and their `--json` records carry `answeredBy` in place of `transport`. `provider probe --provider <id>` is checked against the gateway's candidates when a gateway runs the probe, so a provider configured only on the Host is no longer refused before the probe starts. The TUI's `/provider` documents say the same.
