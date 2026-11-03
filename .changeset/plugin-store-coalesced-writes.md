---
"cognia-next": patch
---

The plugin page no longer stutters while plugins load: plugin state is saved once a burst of changes settles instead of rewriting the whole half-megabyte snapshot on every change (468 writes down to about 10 when opening the page). Pending changes are still saved when you switch or sign out of an account and when the window is hidden or closed, and a removed account's plugin data stays removed.
