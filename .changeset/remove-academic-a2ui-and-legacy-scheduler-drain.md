---
"cognia-next": patch
---

Remove the A2UI academic components (`AcademicAnalysis`, `AcademicSearchResults`) and their templates, which had no data source: they are gone from the renderer, the standard catalog, the agent prompt and the plugin contract, and an old surface naming them renders as an unknown component. Remove the one-shot drain of the pre-v219 `CogniaSchedulerDB` and its `schedulerLegacyDrainCompleted` setting.
