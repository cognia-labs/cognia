---
"cognia-next": patch
---

Short `run_code` programs no longer get slower one after another until they time out on a Mac whose endpoint-security software screens every process launch: the sandbox's memory is now checked every 250 ms (every 25 ms near its limit) instead of 40 times a second, starting once the sandbox is ready, and a program only starts after that check works.
