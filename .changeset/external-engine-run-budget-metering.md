---
"cognia-next": patch
---

External agents under a run budget are now charged what they actually use: a turn's reported usage counts as it arrives, the agent is stopped once its share of the budget is spent, and a turn that ends successfully settles on its usage instead of the whole reservation. Streamed turns no longer lose the usage their final frame reports. An agent on its own login that reports no usage is refused under a token or dollar budget, with a hint to run it on a Cognia model through the Host gateway.
