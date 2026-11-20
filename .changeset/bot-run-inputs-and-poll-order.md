---
"cognia-next": patch
---

Bots: a run that was waiting when you changed a Bot's settings finishes with the settings it started with, and the change applies from the next run. A polling Bot now handles its due checks one at a time, so a check that runs long no longer makes the next one read the same page again. Trigger ids longer than 64 characters are refused when a plugin or a Bot definition is validated, because their runs could not be opened.
