---
"cognia-next": patch
---

Bot handler steps: a step's callback now receives its attempt number and an idempotency key that stays the same for every attempt of that step in a run, so an effect repeated after a lost checkpoint can be deduplicated by the service it writes to. The Python SDK replaces `async with run.step(...)`, whose body ran again on every re-entry, with `await run.step_run(name, fn)`, which skips the callback once the step is checkpointed, like TypeScript's `ctx.step.run`.
