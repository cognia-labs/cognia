---
"cognia-next": patch
---

Importing a cogpack that includes a Git-hosted WASM plugin now reviews that plugin's permissions before it replaces anything; declining keeps the installed version, and a repository that holds a different plugin or version than the cogpack pins is refused.
