---
"cognia-next": minor
---

A remote worker now honours its dispatch lease: it stops admitting tools and turns once the lease lapses or the controlling connection drops, and a strict stop reports "stopped" only after the agent's background processes are proven gone.
