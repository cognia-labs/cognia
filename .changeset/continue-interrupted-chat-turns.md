---
"cognia-next": patch
---

A chat turn cut off by a crash or restart is no longer sent again on its own just because its logs look empty: unless the runtime is known to have declined it, it waits for you, and the runtime that may still be working on it is stopped first. The notice now offers "Continue from where it stopped", which carries the turn on from the saved conversation instead of starting over, and asks first when the turn may already have run tools. Stop now ends such a parked turn instead of failing, and a regenerated or continued reply is tracked as a turn of its own.
