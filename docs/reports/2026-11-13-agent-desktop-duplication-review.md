# agent-desktop duplication review

Date: 2026-11-13. Scope: the uncommitted integration and existing helpers it overlaps. Reuse, simplification, efficiency, and responsibility depth were reviewed separately. CodeGraph has no index in this checkout, so current source was used. Verification remains deferred by user direction.

## Consolidated

| Area                      | Cleanup                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build hashing             | The staging script imports `source-fingerprint.mjs::sha256`, retaining its existing `digest` export.                                                                                                                                                                      |
| Process-group signal      | The CLI owner calls the existing `cognia_exec_sandbox::proc_group::kill_process_group` after proving live-child ownership. Its own reap/absence/quarantine contract remains.                                                                                              |
| Integration identity      | Status uses the protocol owner's VERSION/PROFILE constants instead of repeating literals.                                                                                                                                                                                 |
| Candidate availability    | One Host helper supplies platform/artifact availability to boot health and settings status.                                                                                                                                                                               |
| Request refusal           | Same-typed reply arms share or-patterns; no generic request framework or macro was added.                                                                                                                                                                                 |
| Worker readiness          | The immutable Native lease check runs once per dispatch; canonical actions retain their separate selected-engine check.                                                                                                                                                   |
| Scope invalidation        | Stop and global revocation share the locked epoch/cancel/clear operation, preserving their different stopped flags and notification order.                                                                                                                                |
| State publication         | Complete/partial metadata updates publish the session snapshot once.                                                                                                                                                                                                      |
| Session cleanup           | Revocation and failed initial observation share the adapter's batch removal. Empty cleanup skips binding/token scans, and actual binding retirement uses set membership.                                                                                                  |
| Observation/action copies | Native default observation no longer clones a subtree it never uses. Candidate semantics borrow the Native validation context; explicit Native delivery consumes the already-owned prepared action instead of deep-cloning its tree/frame. Both use one provenance check. |
| Executable verification   | A single bounded streaming verifier hashes every byte. It collects bytes only for the initial private copy; per-spawn verification avoids a full-binary allocation. The redundant immediate post-copy rehash was removed; every spawn still verifies its executable.      |
| Artifact cache            | An already authenticated content-addressed binary is retained instead of rewriting identical bytes. Profile probing and receipt publication remain.                                                                                                                       |

These are source-level reductions in copying, scanning, I/O, and maintenance points; no latency or memory improvement was measured. Hash-verifier regression source was added but not run.

## Similar code retained deliberately

- `JobSupervisor` owns asynchronous jobs, persistent logs, and a job store. The CLI owner needs private stdin, raw bounded JSON, cancellation and inherited-lease cleanup. Sharing the entire supervisor would change privacy and lifecycle semantics. Only the equivalent signal primitive was reused.
- Existing capped sandbox output truncates/converts text; the CLI parser must abort on overflow and preserve raw bytes/read failures. Its reader remains separate.
- Settings persistence is best effort; engine selection needs strict generation/revision CAS and damaged-file recovery. It already reuses the existing atomic writer.
- No exported regular-file reader matches both no-follow and size-limit requirements. No new general filesystem framework was introduced merely to merge short domain-specific readers.
- Host admission, vendor target-window checks, pre-exec integrity, Native/candidate provenance, desired/effective selection and active/candidate health describe different boundaries. Their independent checks/state remain.
- Build/runtime profile checks occur at different trust boundaries. Source-tree hashing also binds executable bits and a named symlink, so it cannot be replaced with the simpler content-only source hash.

No tests, compiler/type checks, lint gates, builds, benchmarks, native fixtures, or UI probes were run. Formatting and source consistency review do not qualify runtime behavior.
