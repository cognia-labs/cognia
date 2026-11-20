---
"cognia-next": patch
---

The self-hosted workspace runtime (the remote-browser profile) now runs as uid 10001, the same user as cognia-server and the runners. Starting it no longer takes the shared `default` workspace away from the server and the runners.
