---
"cognia-next": patch
---

On a remote worker, every agent tool call — including subagents, model-backed hooks and verification batches — now asks the worker's lease before it runs, and a closed lease ends the turn instead of returning a tool error the model could retry.
