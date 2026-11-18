---
"cognia-next": patch
---

Load unpacked and bundled-plugin seeding now install only the plugin that was reviewed: a directory whose plugin id or manifest changed, or a bundled plugin whose files differ from its catalog, is refused.
