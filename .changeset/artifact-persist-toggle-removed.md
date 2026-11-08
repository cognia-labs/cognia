---
"cognia-next": patch
---

Removed the "Persist across sessions" switch from artifact settings. It did nothing: artifacts are always kept in your account's local database, and its description wrongly said they were stored in localStorage.
