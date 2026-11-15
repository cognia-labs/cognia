---
"cognia-next": major
---

The CLI no longer reads data, config or command names from older versions. This covers:

- durability rows written before value codec 1, and the old single-file and format-3 snapshot stores
- the old table-store import that ran on the first `serve` boot
- the legacy tool-approval and plugin-state file shapes
- schema-1 process lease records
- the `classic` theme name
- the `/init regenerate` and `/init optimize` aliases
