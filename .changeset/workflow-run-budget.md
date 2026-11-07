---
"cognia-next": minor
---

Workflows can set a run budget in dollars (editor settings, or a playbook's `limits.maxBudgetUsd`). Reported and model-priced costs count against it; once it is spent the run stops with a "budget spent" reason. Steps whose cost cannot be priced do not stop the run and are listed as "not covered by the budget" in the run log and run summary. A sub-workflow inherits what its parent has left.
