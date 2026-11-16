---
"cognia-next": patch
---

Streaming a reply in a long conversation no longer slows down with its length: each streamed token cost about 3 ms at 2,000 messages and 27 ms at 5,000, and now costs 0.1 ms and 0.3 ms.
