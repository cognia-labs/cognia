---
"cognia-next": minor
---

Harden long-term memory security boundaries, durable lifecycle jobs, workspace history backfill, capability controls, portability, and end-to-end evaluation (`N1`–`N17`, `G1`–`G8`):

- Enforce paired-device `owner`/`member` personal-memory visibility and `principalGrants` across Companion RPC and Dexie memory sync, fail-close member procedural review promotions, commit idempotent `memoryOperations` receipts atomically with retry recovery, scrub deleted memory excerpts from historical reply citations, and defer personal-mark propagation until memories are actually consumed.
- Fence `session-distill`, `project-mining`, and `memory-lifecycle-sweep` writes against mid-flight job/run cancellation, in-place source edits, and concurrent user edits/pins; synchronously invalidate unsupported project claims upon source message deletion/edit; prevent zero-evidence claims from starving daily revalidation sweeps; propagate per-session `memoryLearn` overrides consistently.
- Isolate workspace backfill paging across prefix-sharing project IDs, serialize backfill enqueue against cancellation, keep runs active while pending mining jobs drain, and drive confirmed backfills autonomously from the background memory job worker.
- Add per-workspace `project-only` memory isolation (`ProjectMemoryPolicy`), sensitive-topic classification and default quarantine (`allowSensitiveTopics`), multi-session diversified `project_history_search` with decomposed fallback and pagination, dedicated memory embedding and vector store configuration (`embeddingSource: "custom"`), scoped JSON/Markdown memory export and reviewed import wizard, an end-to-end LongMemEval & governance benchmark suite, direct chat `SourcesPart` citation controls, and refreshed EN/ZH memory documentation.
