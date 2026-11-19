---
"cognia-next": patch
---

Bot settings changes no longer overwrite each other: saving a configuration while disabling the Bot, or switching two triggers at once, keeps every change. Uninstalling a Bot stops it accepting work before its cleanup hook runs. On a paired device, a trigger switch retried after a later one can no longer undo it, switching a trigger on a disabled or not-yet-set-up Bot no longer reports an error, and a queued switch is reported as queued until the Host applies it. A Host now answers a replayed install with its original receipt after the plugin upgrades, and repeated Retry presses keep a run's detail openable.
