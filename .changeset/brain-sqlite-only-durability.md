---
"cognia-next": major
---

The headless brain now keeps each account in its SQLite store only: the older snapshot and journal stores, the backend manifest, `COGNIA_DURABILITY_BACKEND`, `serve --flush-debounce` and the `durability migrate`, `recover`, `rollback` and `finalize` commands are gone, `durability verify` checks just the SQLite store, and Host backups no longer accept snapshot or journal brain data.
