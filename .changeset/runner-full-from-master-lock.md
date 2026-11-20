---
"cognia-next": minor
---

The Full Runner image now installs its Agents from the master bundle lock, with every transitive dependency pinned and the pinned Node, through the same steps as a selected build. Its Agent commands move from `/usr/local/bin` to `/cognia/glibc/bin` (still on `PATH`). The per-Agent `*_VERSION` build arguments are removed; change versions in the bundle pins instead. Project tools run through `npx` still fall back to the base image's npm online, as before. The cognia-server full image keeps its current install for now.
