---
"cognia-next": patch
---

Harden project environment setup reuse, concurrency, cancellation, and multi-host isolation:

- Revalidate setup reuse inputs, outputs, and `mise` plans after joining an in-flight setup and after completion so mid-flight lockfile or manifest edits cannot be skipped or recorded under a stale fingerprint.
- Keep unsettled interrupted `running` setup attempts as the latest history entry so crashed setups never fall back to reusing an older success.
- Serialize concurrent setups per execution Host and canonical workspace directory on both client and Host, and isolate persisted setup history and flight coalescing by execution Host.
- Add Host-side `project_environment_cancel` support with bounded pipe capture and Windows Job Object tree termination, and surface redacted stdout/stderr, truncation/timeout indicators, and a Cancel button in the Project Environment settings panel.
- Reload Runtime Environment, Sandbox Management, repository config, and worktree provisioning panels reactively on Host switches while keeping in-flight build cancellations pinned to their originating Host.
