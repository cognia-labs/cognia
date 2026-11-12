---
"cognia-next": patch
---

Plugins that run on the Node runtime keep one process for their whole activation, so state set up in `activate` survives across callbacks and deactivation, context calls made inside callbacks actually run and return real values, activation waits for its host calls, and stopping a plugin no longer lets a waiting callback start a new process.
