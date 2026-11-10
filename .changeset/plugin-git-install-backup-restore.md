---
"cognia-next": patch
---

Installing a WASM plugin from Git now reviews its capabilities before replacing anything (cancelling keeps the installed version) and reloads the plugin list afterwards; restoring a plugin backup restores the exact snapshot you chose, says when a restart is needed, and reports failed restores and deletes.
