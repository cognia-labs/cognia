---
"cognia-next": patch
---

Plugin hot reload no longer loops or leaves a plugin half-loaded.

- `cognia plugin dev` on a frontend plugin stopped rebuilding and reloading in an endless loop. Each build rewrote `dist/index.js`, which the watcher counted as an edit; files the build writes no longer start another build.
- Saving again while a plugin was still reloading started a second reload of the same plugin alongside the first, which could leave it shown as enabled with nothing running. Reloads of one plugin now run one at a time, and changes made during a reload are picked up by one more reload when it finishes.
