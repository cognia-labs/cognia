---
"cognia-next": patch
---

External agents started from the desktop no longer inherit the app's whole environment. Like the CLI host, they get the session and toolchain variables, your SSH agent, model-provider credentials and the variables their own engine reads; unrelated secrets such as AWS access keys stay out. Gateway tasks and SIWC runs get the runtime essentials only.
