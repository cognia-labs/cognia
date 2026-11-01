---
"cognia-next": patch
---

A headless brain restored from a snapshot store written before value codec 1 now records the values that store may have lost (dates kept as text, maps and sets kept empty, files without their names) in its value-loss report, which `cognia-agent durability verify` lists, instead of restoring them silently. A store written by a newer version is now refused as incompatible rather than called corrupt.
