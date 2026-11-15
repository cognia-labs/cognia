---
"cognia-next": major
---

Workflows now accept only the current node shapes: `flow.branch` / `flow.switch` use structured conditions, `flow.loop` is always a container, `ai.prompt` is version 2, and a workflow must be `schemaVersion` 2. Nodes saved in the old v1 shapes, older workflow files, and the loop `onItemError: "skip"` spelling are refused with a clear message instead of being run; the built-in templates are rewritten to the current shapes.
