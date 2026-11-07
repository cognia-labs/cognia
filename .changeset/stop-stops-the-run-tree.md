---
"cognia-next": patch
---

Stopping a run now stops everything running under it: a subagent's own subagents, a delegated Squad's delegations, and the children of a run stopped from the run monitor; the run monitor's Stop also works for plugin agents, twin answers and best-of-N candidates.
