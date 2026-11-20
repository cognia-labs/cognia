---
"cognia-next": patch
---

Code and Both tool modes now reach the agent when the Host can sandbox them: the mode picker asks the Host that runs the turn, shows Code and Both as disabled with the reason when it cannot (no OS sandbox, turned off, older Host), and `run_code` stops with the turn, keeps its output within byte limits and reports nested tool failures the same way on both engines.
