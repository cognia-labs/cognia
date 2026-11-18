---
"cognia-next": patch
---

Artifact and Canvas edits and reviews keep what the user saw: accepted hunks land exactly where the diff showed them (including blank-line insertions and filling an empty document), unsaved artifact edits survive switching tabs or a Preview request, a save that would replace a newer revision asks first, a saved version appears in history at once, restoring an older version keeps its Canvas document, and Re-diff carries a stale proposal over the user's own edits instead of offering to undo them.
