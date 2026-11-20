---
"cognia-next": patch
---

Stopping a goal now wins over its verification: a check still running when you stop, or one picked up again after a restart, can no longer pause or complete the goal afterwards, and a goal whose check had already passed before a restart is completed on the next start. A held goal continuation goes to the goal's own chat, and only if the goal is still running when it is released.
