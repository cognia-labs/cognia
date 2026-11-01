---
"cognia-next": minor
---

Plugins can contribute backup destinations through `ctx.backup.registerDestination`. They receive only encrypted snapshots. The Host keeps packaging, encryption, scheduling and history, and built-in WebDAV, GitHub and Google Drive run through the same registry (ADR-0246).
