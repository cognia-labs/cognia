---
"cognia-next": patch
---

The external tool usage index (Claude Code, Codex and other agents' logs) no longer erases history when a transcript fails to read, the tool's folder is not visible for a moment, a refresh resumes part-way, or a shorter time window is queried: it replaces only the sessions it read, retires a session only after it is missing twice in a row, and never writes one account's scan into another account after switching.
