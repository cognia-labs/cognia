---
"cognia-next": patch
---

Pages load more smoothly while the app is busy: the sliding highlight behind the selected rail button, sidebar entry and dock tab no longer forces the whole page to re-measure every time the rail redraws (about 470 ms of extra layout while the plugin page loaded). The highlight still glides to the new selection.
