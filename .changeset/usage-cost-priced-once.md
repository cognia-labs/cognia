---
"cognia-next": patch
---

Usage and cost figures now price each call once and correctly: a chat turn whose runtime reported no cost is priced from its tokens instead of counting $0 against budgets, cached prompt tokens and TTL-split cache writes are no longer billed twice, fast-mode, US-only and batch requests use their published rates, your own custom model prices apply, a turn with an unpriced tool shows as a lower bound, and the usage CSV says which costs are known, where they came from and whom they are attributed to.
