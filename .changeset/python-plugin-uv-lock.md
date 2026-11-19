---
"cognia-next": patch
---

Python plugins can pin their dependencies with `uv.lock`: Cognia installs exactly what the lock pins with uv into the plugin's own environment, offline when the plugin bundles its wheels. A locked plugin without uv offers to install uv first instead of falling back to pip, an out-of-date lock or a missing bundled wheel is named when preparing fails, and an update that changes the lock asks to prepare again.
