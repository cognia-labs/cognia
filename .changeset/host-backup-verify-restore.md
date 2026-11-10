---
"cognia-next": patch
---

Host backups now copy a consistent snapshot, report their real storage kind and only claim "verified" after the copy was checked; `verify-restore` and `durability verify` check every known store and the rows restore would load, and `cognia doctor` prints safely quoted commands only inside a Cognia checkout.
