---
"cognia-next": patch
---

Background commands keep working on later turns of the same chat, finished background jobs no longer linger as zombie processes, and a turn's wake hold is released even where stop proof is unavailable (Windows, Bun terminals) or the send was refused before it started.
