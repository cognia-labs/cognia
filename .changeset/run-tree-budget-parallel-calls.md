---
"cognia-next": patch
---

A run budget now holds when one run makes several model calls at once (they share the run's allowance instead of each getting all of it), a token cap counts the prompt as well as the answer, a model with no known price is refused under any dollar limit above it, and Council and Ensemble steps and Bot-started workflows now spend from their run's budget.
