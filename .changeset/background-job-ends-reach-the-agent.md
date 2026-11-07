---
"cognia-next": patch
---

A shell command or watch the agent leaves running in the background now reports back when it ends: the conversation that started it receives the exit code (or the watch's verdict) and the end of the output, and an idle conversation picks it up on its own. Ends that arrive together are merged, a conversation is woken at most six times an hour and never over the spending limit (a notification says when results are waiting), the agent can ask for no report, and a job it stopped itself or a result it already saw does not come back. Ends missed while the app was closed or a paired Host was out of reach are picked up again, and only one window or device delivers each.
