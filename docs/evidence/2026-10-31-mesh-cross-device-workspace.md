# Evidence ledger: Cognia Mesh cross-device workspace review

- Status: building
- Lane: deep
- Created: 2026-10-31
- Updated: 2026-10-31
- Related: [revised plan](../plans/2026-10-31-cognia-mesh-cross-device-workspace.md); [ADR-0244](../content/docs/en/adr/0244-a-remote-run-has-stopped-only-when-its-worker-says-so.md); [ADR-0245](../content/docs/en/adr/0245-a-paired-device-is-granted-workspaces-not-a-host.md); probes in `2026-10-31-mesh-cross-device-workspace.probes/` (copied from `.cache/verification/2026-10-31-qoder-p0/`); working tree on `codex/modular-sync-20261030`, HEAD `5ee04bcdb8`

## Verdict

REQ-02, REQ-03 and REQ-05 are real, new problems; REQ-05 carries the highest risk. REQ-01, REQ-04 and REQ-08 are mostly built. REQ-07 and REQ-09 are not cross-device work and are split out. Four defects found during the review were fixed separately (V5–V8). Recovery safety (R1) is proven only at mechanism level: no real two-worker run exists yet.

## Original request

> 辩证看待下面的问题……先判断是不是问题，以及是否可行（Cognia Mesh 跨设备 Agent 工作区需求评审稿 2026-10-31，REQ-01～REQ-09）

## Knowledge

| ID  | Statement                                                                                                                                                        | State        | Basis                                                                                                                                                                 | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Judge each REQ for reality and feasibility, settle the open decisions with the user, and produce a revised plan, two ADRs and this ledger.                       | Agreed       | User request and grilling rounds, 2026-10-31                                                                                                                          | -          |
| C1  | Shared working tree: touch only this task's paths; one Codex implement job at a time.                                                                            | Verified     | CLAUDE.md rule 8; codex-agent runner attribution showed no Codex out-of-scope edits                                                                                   | -          |
| O1  | Every pairing invitation registers an Owner with `host.admin`, `terminal.open`, `process.spawn` and `secret.manage`.                                             | Verified     | `crates/cognia-companion-security/src/security_store.rs` `register_owner_device` and default grants (~3072-3100); haiku Explore read, 2026-10-31                      | -          |
| O2  | Device grants have no workspace or root dimension; `Control` bundles agent.run, workspace read/write, git and workflow.                                          | Verified     | `capability_grants` schema in `security_store.rs` (~4164); `device_grants.rs`; `lib/devices/grant-capabilities.ts:23-50`                                              | -          |
| O3  | Remote `write_text_file_confined` / `ensure_dir_confined` took `allowedRoots` from the RPC arguments.                                                            | Verified     | `crates/cognia-companion-rpc/src/rpc/filesystem.rs:261-293` at HEAD, read by Claude 2026-10-31                                                                        | -          |
| O4  | `root/missing/../../x` passed the deepest-existing-ancestor check and `create_dir_all` + `fs::write` escaped the root.                                           | Verified     | `crates/cognia-files/src/files.rs` `is_within_canonical_roots` / `write_text_file_impl` at HEAD; four new regression tests failed before the fix (Codex run, V5)      | -          |
| O5  | After dispatch, remote cancel and decision answers resolved the active Host at call time, not the run's Host.                                                    | Verified     | `lib/ai/agent/external/runtimes/remote/remote-run-client.ts:272-305` at HEAD; three new regression tests failed before the fix (Codex run, V7)                        | -          |
| O6  | Codex `approval_policy="never"` mapped to `bypassPermissions` and `danger-full-access` to sandbox off, applied under the overwrite strategy with only a warning. | Verified     | `lib/settings-import/adapters/codex.ts:9-66`, `lib/settings-import/apply.ts:40-80` at HEAD, read by Claude                                                            | -          |
| O7  | No stop-requested / stop-confirmed / stop-unconfirmed state exists; `durable-control.ts` writes `cancelled` before children stop.                                | Verified     | Grep across execution, recovery, durable, companion and sidecar dirs; `lib/ai/agent/team/durable/durable-control.ts:37-77`                                            | -          |
| O8  | Remote pause is `session.waitForIdle({ timeoutMs: 30000 })` with no abort.                                                                                       | Verified     | `lib/ai/agent/team/workers/worker-rpc-pool.ts:129-131`                                                                                                                | -          |
| O9  | The stdio agent RPC server drains an admitted turn after stdin EOF before closing the service.                                                                   | Verified     | `worker-eof-probe.ts.txt`: events `turn_started, side_effect_after_eof, service_closed`; real RPC server, stub handler, no device or model                            | -          |
| O10 | A child whose last Write tool result settled is marked replay-safe after "connection closed" and can be retried on another host with no stop evidence.           | Verified     | `recovery-admission.test.ts.txt` (`settled=true` case), fake-indexeddb, no real worker                                                                                | -          |
| O11 | Same-host retry skips the replay-safety check; startup recovery reads neither lease nor host liveness.                                                           | Verified     | `packages/agent-orchestration/src/coordinator.ts:738-781` (`changesHost && !safeToMigrate`), `:699-731`                                                               | -          |
| O12 | Lease renew and settle compare only the lease id, and a reclaim reuses an expired-but-uncleared lease id.                                                        | Verified     | `packages/agent-orchestration/src/rules.ts:118-136`; `dispatch-teammate.ts:1322-1324`                                                                                 | -          |
| O13 | Approval interrupts carry no child or attempt binding.                                                                                                           | Verified     | `ExecutionRunInterrupt` in `packages/plugin-contract/src/types/execution/run.ts` (~588); `team-recovery.ts:219-227`                                                   | -          |
| O14 | Composer `ContextRef` file entries have no host field and `@` targets have no device dimension.                                                                  | Verified     | `packages/plugin-contract/src/lib/chat/mentions/types.ts:30-47`; `lib/agent-team/runtime-targets.ts:32-85`                                                            | -          |
| O15 | Remote configs already have CRUD, revision CAS, version-bound runs, credential refs and 13 readiness reasons; delete has no CAS and quota is not checked.        | Verified     | `lib/db/external-agent-configs.ts`, `lib/ai/agent/external/policy/run-admission.ts:101-188`, `packages/agent-contracts/src/external-agent-lifecycle.ts:33-61,502-508` | -          |
| O16 | None of the 8 built-in team templates combines dev, test and review or declares deliverables; review approval is a model verdict.                                | Verified     | `packages/plugin-contract/src/types/agent/agent-team.ts:1859-2100`; `lib/ai/agent/team/workflow-nodes/index.ts:441-482`                                               | -          |
| O17 | The headless Host's file-root registry is always empty; its trusted roots come from the spawn policy.                                                            | Verified     | Doc comment on `GitWorkspaceSource` in `crates/cognia-companion-rpc/src/rpc/source_control.rs:35-60`; no registration call in headless crates                         | -          |
| H1  | Worker self-fencing (lease check before every tool call, abort on renewal loss) plus acknowledged stop is sufficient stop proof for recovery.                    | Hypothesized | ADR-0244 design; not built or measured                                                                                                                                | O9, O10    |
| Q1  | What fence grace and revocation propagation times hold on the macOS ↔ Linux box rig?                                                                             | Open         | To be measured before any number enters a release gate                                                                                                                | H1         |
| Q2  | Can the per-Host management channel carry run event subscriptions so a switched-away run stays live (plan D13)?                                                  | Open         | Management channel serves host-config RPCs today; subscriptions not traced                                                                                            | -          |

## Problem frame

A person delegates work from one device to a workspace on another of their devices and keeps control of it. Within this frame the core risks are false confidence about stopping (O7–O12), access wider than intended (O1–O4) and control reaching the wrong Host (O5). The outcome is a delegation loop that is never silently wrong: no double execution, no widened access, no misrouted control. Multi-person Hosts, browser profiles, Codex import and team templates are out of frame (plan D1, D2, D8).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                 |
| ------------ | ------ | ------------------------------------------------------------------------------------------- |
| scale        | high   | Six REQs across Rust host, worker CLI, orchestration package, composer and console          |
| technical    | high   | Distributed stop proof and fencing (H1); canonical path containment across OSes             |
| coupling     | high   | Wire changes on dispatch, interrupts and file requests; old clients must be refused cleanly |
| requirement  | medium | Decisions D1–D15 settled; Q1 numbers and Q2 feasibility remain                              |
| verification | high   | Unit tests cannot prove R1; needs the two-device rig                                        |
| risk         | high   | Double side effects and access escalation are irreversible                                  |

## Risks

| ID  | Risk (impact)                                                                       | Severity | Source                        | Claim                                                                         | Refuted by                                                                         |
| --- | ----------------------------------------------------------------------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | A retried child runs on a second worker while the first still produces side effects | high     | O9, O10, O11                  | A child is re-dispatched only after stop proof for the previous attempt       | A two-worker run where attempt 2 starts while attempt 1 can still call tools       |
| R2  | A paired device writes outside the workspace it was meant to reach                  | high     | O3, O4, lens:STRIDE elevation | Remote writes stay inside Host-trusted roots, and requester roots only narrow | A remote call writes or creates a directory outside a Host root                    |
| R3  | Cancel or approval answers reach a different Host after a host switch               | medium   | O5                            | Run control goes to the Host running the run or fails explicitly              | A cancel after a switch reaching the new Host                                      |
| R4  | An import silently turns on permission bypass or disables the sandbox               | medium   | O6                            | Imports never enable bypass, auto-approval or sandbox-off                     | A draft or apply path writing `bypassPermissions` or `sandboxDefaultEnabled=false` |
| R5  | A stale approval authorizes a newer attempt                                         | medium   | O13                           | Decisions apply only to the attempt they were raised for                      | A recovery approval acting on a child re-dispatched since                          |
| R6  | The confinement fix breaks remote writes on the headless box                        | medium   | O17, reviewer (Claude)        | Headless confined writes inside the policy root still work                    | A headless confined write under the workspaces root refused                        |

## Verification obligations

| ID  | Risk   | Method                                                                                                 | Independence | Evidence                                                                                         | Coverage                                                 | Status  |
| --- | ------ | ------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------- |
| V1  | R1     | Read probe and orchestration code                                                                      | subagent     | O9, O10, O11 (haiku Explore + Claude read)                                                       | Mechanism only; no remote device, no model               | passed  |
| V2  | R1     | Controlled two-worker run on the rig, per ADR-0244                                                     | real-env     | -                                                                                                | Disconnect, revocation, Host restart, approval wait      | planned |
| V3  | R2     | Containment regression tests (`missing/../..`, `./..`, symlinked ancestor, canonical alias)            | tool         | `cargo test -p cognia-files --lib files::tests`: 80 passed (Claude rerun, 2026-10-31)            | macOS; Windows prefixes not run                          | passed  |
| V4  | R2, R6 | RPC confinement tests (desktop registry bound, narrower root kept, headless policy bound, `/` refused) | tool         | `cargo test -p cognia-companion-rpc --lib rpc::filesystem`: 11 passed (Claude rerun)             | Stub hosts; no real paired device                        | passed  |
| V5  | R2     | Fix implementation reviewed by a second model                                                          | other-model  | Codex gpt-6.1-sol xhigh implemented; Claude reviewed the diff and found R6, fixed in a follow-up | Static review                                            | passed  |
| V6  | R6     | Headless confined write on the real box                                                                | real-env     | -                                                                                                | ADR-0224 box                                             | planned |
| V7  | R3     | Pinned-host tests: switch then cancel/resolve; admin lease across await                                | tool         | `pnpm test` on 6 suites: 215 passed (Claude rerun, 2026-10-31)                                   | Mocks; local-origin runs are refused, not delivered (X3) | passed  |
| V8  | R4     | Import safety tests across codex, claude-code, opencode, pi adapters and apply                         | tool         | Codex run: 14 suites / 76 tests passed; Claude rerun pending after the allow-rule follow-up      | Unit level                                               | planned |
| V9  | R5     | Interrupt epoch binding tests                                                                          | tool         | -                                                                                                | Part of M1a/M1b                                          | planned |

## Decisions

| ID  | Date       | Decision                                                                                                       | Action     | Based on       | Reversal trigger                                       |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ------------------------------------------------------ |
| D1  | 2026-10-31 | Primary scenario is one person's devices; multi-person Hosts reuse org membership                              | scope-down | G1             | The user prioritizes shared Hosts                      |
| D2  | 2026-10-31 | Split REQ-07 and REQ-09 out of Mesh, queued after M1a                                                          | scope-down | O15, O16       | -                                                      |
| D3  | 2026-10-31 | Fix the four confirmed defects now, separately                                                                 | harden     | O3, O4, O5, O6 | -                                                      |
| D4  | 2026-10-31 | Workspace grants cover files and history only; execution stays Host-level unless an enforceable sandbox exists | implement  | O2             | A Host-enforced confinement that holds against a shell |
| D5  | 2026-10-31 | Stop proof = worker self-fence or acknowledged stop; no tool idempotency keys                                  | implement  | O9, O10        | H1 invalidated on the rig (V2)                         |
| D6  | 2026-10-31 | Keep Owner invitation; add a restricted invitation with zero grants                                            | implement  | O1             | -                                                      |
| D7  | 2026-10-31 | M1a = REQ-05 + target pinning; M1b = REQ-02, REQ-01 hardening, remote @file, Attention safety items            | implement  | O7–O14         | -                                                      |
| D8  | 2026-10-31 | Same recovery rule for same-host, cross-host and startup recovery                                              | implement  | O11            | -                                                      |
| D9  | 2026-10-31 | Acceptance rig: macOS desktop ↔ Linux box                                                                      | experiment | -              | -                                                      |

## Residual risks

| ID  | Residual                                                                                                             | From   | Why still open             | Next action                    | Status |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------- | ------------------------------ | ------ |
| X1  | Recovery double execution is proven only at mechanism level                                                          | R1, V2 | No real two-worker run yet | M1a rig run                    | open   |
| X2  | Windows path prefixes in containment are not exercised                                                               | V3     | macOS-only tests           | Windows CI or VM run before GA | open   |
| X3  | A run that started on this machine cannot be cancelled while a remote Host is selected (refused with `host-changed`) | V7     | Fix scope kept narrow      | Fold into M1a target pinning   | open   |
| X4  | Fence grace and propagation numbers unknown                                                                          | Q1     | Not measured               | Measure on the rig             | open   |
| X5  | Keeping a switched-away run live may not fit the management channel                                                  | Q2     | Not traced                 | Spike in M1a                   | open   |

## Outcome

| ID  | Signal                                                                                                                      | How / when measured | Result | Status  |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------ | ------- |
| M1  | A real macOS → box delegation completes grant → delegate → approve → result with no misrouted control or double side effect | M1 acceptance run   | -      | pending |
