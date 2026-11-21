---
"cognia-next": patch
---

Fix Pi and Oh My Pi (OMP) support audit issues (#01-#13, #15-#19, #21):

- Isolate timed-out Pi RPC turns, prevent uncertain-delivery auto-retries, and harden version probe exit/cleanup, process slot concurrency, disconnect races, missing-session resume detection, and background-turn hot-swap checks (#01, #04-#09).
- Map Oh My Pi native `plan` mode correctly with strict approval ceilings, preserve per-turn `PromptResponse.usage` separately from session context occupancy, and accept OMP steering `promptRequired` outcomes (#02, #03, #11).
- Update Pi adapter docs to certified `1.0.2` (min `0.85.1`), certify OMP ACP `18.22.2` in the runtime catalog, project `_omp/compaction/*` vendor notifications into canonical compaction metadata, and reserve structured `promptFailure` handling (#10, #12, #13, #18).
- Add the Cognia Gateway model recipe for `oh-my-pi`, register OMP JSONL session history import, `ompAgentDir`/`ompSessionDir` vendor roots, and migration catalog entries, and add the dedicated OMP host/account/readiness & security-boundary diagnostic card (#15-#17, #19, #21).
