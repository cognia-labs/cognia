---
"cognia-next": patch
---

When a check on an integration candidate cannot confirm that it stopped, the integration's working copy is now kept until the check's time limit has passed, even across a retry, a restart or a Best-of-N publish. Agent Changes says why the integration is held, and Abort asks you to confirm the check is no longer running before it resets the working copy.
