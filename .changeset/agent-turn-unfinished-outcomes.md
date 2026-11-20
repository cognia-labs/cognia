---
"cognia-next": patch
---

A built-in agent turn that did not finish (a provider error after partial output, an upstream 404, a step or budget ceiling, a reply cut at the token limit) now settles as failed instead of completed: it no longer advances the plan step, fires the post-receive hooks or lets a verifier pass on a cut-short answer, and a Stop settles as cancelled. Each turn reports exactly one end, paired Hosts settle ceilings the same way, headless runs hand back what streamed before a failure, and AI SDK turns report their real step count.
