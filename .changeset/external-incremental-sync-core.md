---
"cognia-next": minor
---

Add the Host's shared incremental-sync core for external services. Cursors are committed per page and never advance on failure. An invalid cursor triggers a full rebuild that marks unseen items removed. Rate limits are backed off, offline runs resume later, and purging a plugin's data also clears its sync state.
