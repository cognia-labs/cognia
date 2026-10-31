---
"cognia-next": patch
---

The `cognia-agent` CLI now keeps plugin sign-in connections across runs: Host auth credentials and pending sign-ins are stored in owner-only files under the CLI home, and concurrent CLI processes share a file lock so a token refresh happens once and plugin state writes are never lost (ADR-0246).
