---
"cognia-next": patch
---

`cognia host` runs again with the current command catalog. It also accepts request bodies up to the Host's 16 MiB limit, keeps `--timeout-seconds` as the budget for the whole call, never re-sends a write that takes no idempotency key once it may have arrived, checks `--paginate` and `--query` before anything runs, and adds `cognia host operation <id>` to follow a `--no-wait` call.
