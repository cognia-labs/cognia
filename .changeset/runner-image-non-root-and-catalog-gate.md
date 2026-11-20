---
"cognia-next": patch
---

The Runner image builds again: every Agent in the runtime catalog now has a bundle classification, and the catalog check catches a missing one. Runner containers run as uid 10001 instead of root, Cursor is installed only when the build asks for it, and the image smoke now checks the Codex app-server and Cline handshakes and a workspace write.
