---
"cognia-next": patch
---

Keep debugging evidence accurate and private. Desktop crash reports are scrubbed (home paths, hostname, credentials, emails) before they are previewed or packaged, and a submission is refused if anything sensitive remains. A retry reuses the same package, and reports created in the same second no longer overwrite each other. Native log forwarding no longer loses entries after repeated failures and now carries span, execution and request IDs. Browser Network shows real request durations, Console and plugin logs keep an Error's message, stack and cause, and Workflow run details show the inputs each attempt actually ran with, per retry or loop iteration, with the failure stack. Traces imported into Eval get the prompt of their own turn, support report headers are redacted, a debug session that cannot be saved now says so, and a chat turn whose log could not be fully written is reported as incomplete.
