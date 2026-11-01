---
"cognia-next": patch
---

Turning on outbound enforcement no longer sends connector deliveries that were queued while it was in shadow mode and would have been held: the runner plans them again before sending and parks them as a draft or refuses them, and a queued job now records how it was authorized.
