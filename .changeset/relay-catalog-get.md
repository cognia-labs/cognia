---
"cognia-next": minor
---

A device that reaches its Host only through the relay room can now read the Host's live command catalog. `cognia-agent api list --live` and `api call --live` fall back to the relay when the Host's address does not answer, and the paired app reads the catalog, and with it the contract check, over the relay as well. The Host answers in pages small enough for the relay. An older Host says it cannot list its catalog over the relay, rather than appearing unreachable.
