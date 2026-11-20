---
"cognia-next": patch
---

External MCP tools that report a failure now show as failed to the agent, hooks and chat instead of succeeding, a result that does not match the tool's declared output schema is refused, and a valid structured result reaches the model in full. Plugin tool deadlines mean the same on every path: a standalone chat honours a tool's declared timeout, and a call reported as timed out is cancelled rather than left to finish.
