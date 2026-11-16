---
"cognia-next": minor
---

Budgets now hold across a whole run tree: subagent token and time limits, a Bot's cost ceiling, a workflow's cost cap and a best-of-N cost cap share one ledger that every model call reserves from before it starts, so parallel children, sub-workflows, retries and resumes can no longer overspend. A workflow step whose model has no price is refused under a cost cap instead of running uncounted, and a manual re-run starts with a fresh budget.
