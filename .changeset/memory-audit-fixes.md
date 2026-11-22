---
"cognia-next": minor
---

Harden long-term memory security boundaries, durable lifecycle jobs, workspace history backfill, and reply citation controls (`N1`–`N17`, `G1`, `G2`, `G6`):

- Enforce paired-device `owner`/`member` personal-memory visibility and `principalGrants` across Companion RPC and Dexie memory sync, fail-close member procedural review promotions, commit idempotent `memoryOperations` receipts atomically with retry recovery, scrub deleted memory excerpts from historical reply citations, and defer personal-mark propagation until memories are actually consumed.
- Fence `session-distill`, `project-mining`, and `memory-lifecycle-sweep` writes against mid-flight job/run cancellation, in-place source edits, and concurrent user edits/pins; synchronously invalidate unsupported project claims upon source message deletion/edit; prevent zero-evidence claims from starving daily revalidation sweeps; propagate per-session `memoryLearn` overrides consistently.
- Isolate workspace backfill paging across prefix-sharing project IDs, serialize backfill enqueue against cancellation, keep runs active while pending mining jobs drain, and drive confirmed backfills autonomously from the background memory job worker.
- Add direct memory inspect, inline correction, and archive/restore controls in chat `SourcesPart`, effective scope readouts in session settings, Twin-worker-free embedding resolution, and refreshed EN/ZH memory documentation.
