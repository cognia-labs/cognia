---
"cognia-next": patch
---

Restoring a managed workspace to an earlier snapshot no longer empties the folder before the snapshot is ready. The snapshot is built beside the folder and swapped in only when complete, so a restore that fails leaves the folder as it was. A restore is refused while any run is still working in that folder.
