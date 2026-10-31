---
"cognia-next": patch
---

Workflow schedules the background trigger service cannot run are now refused in the editor instead of being saved and then never firing, and the preview of upcoming runs matches what the service will actually do. When saving a workflow cannot register its triggers, the editor now says so (desktop and mobile) and the registration is retried at the next startup, instead of the save looking successful.
