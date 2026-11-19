---
"cognia-next": patch
---

Python Bot plugins now run in the app as the author guide shows: `from cognia.bot import define_bot` resolves inside the embedded Python host, and a Bot's `run` receives a `BotRun` (`run.run_id`, `run.step_run(...)`) instead of a plain dictionary.
