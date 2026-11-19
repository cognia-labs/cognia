# Evidence ledger: agent desktop integration

- Status: building
- Lane: deep
- Created: 2026-11-13
- Updated: 2026-11-13
- Related: [implementation plan](../plans/2026-11-12-agent-desktop-integration.md)

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 按这个方案开始实施，先完成 P0 的兼容补丁和验证，再继续推进后续阶段。注意集成位置合理，架构合理

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                              | State        | Basis                                                                                                   | Depends on |
| --- | ------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Native automation belongs to cognia-automation; Tauri assembles it                                     | Verified     | rust-architecture.json, current worker/startup, 2026-11-13                                              | -          |
| O2  | Retained macOS refs lack final source-window validation upstream                                       | Verified     | pinned retained_resolve/ref_action/ax_ipc sources, prior fresh review, 2026-11-13                       | -          |
| O3  | Isolated source checkout is 2b0a7334fc111730454b726e6800aa41cdafc093                                   | Verified     | git rev-parse HEAD in .cache/agent-desktop-p0/upstream, 2026-11-13                                      | -          |
| H1  | Explicit ref context plus a scoped mutation guard can prevent reparented-target delivery               | Hypothesized | shared AX mutation gateway found; regression and native fixture pending                                 | O2         |
| H2  | Candidate CLI can retain a supervisor lease across Host death                                          | Hypothesized | actual inherited-descriptor crash check required                                                        | O3         |
| G1  | Implement the staged design; defer verification and continue normal implementation                     | Revised      | user: 继续，先跳过验证，就正常实现; 2026-11-13                                                          | -          |
| C1  | No wrong-target input, duplicate mutation, silent fallback or mock-only native acceptance              | Verified     | approved plan A1-A16, 2026-11-13                                                                        | -          |
| C2  | Preserve concurrent changes; use disposable fixtures, no TCC changes or personal-app driving           | Verified     | task scope and repository instructions, 2026-11-13                                                      | -          |
| O4  | Host/session integration, local settings, lifecycle port and preview staging are now present in source | Observed     | current task-owned changes; [integration notes](../../integrations/agent-desktop/README.md), 2026-11-13 | O1,G1      |
| Q1  | Are native permissions and target/spectator fixtures usable under the candidate executable identity?   | Open         | earlier disposable probes predate the latest patch and production integration                           | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Add a safe optional local application-session engine while Native retains capture and physical-input ownership (O1/G1). First repair and verify the pinned upstream window-binding and process-lifetime gaps (O2/H2). The user explicitly deferred verification while implementation continues. Native stays the default; candidate packaging requires an explicit preview build flag, and no release qualification is claimed (C1). Personal application state and system permission changes remain outside this implementation turn (C2).

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating  | Why / what would resolve it                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------------- |
| scale        | high    | pinned build and native patch followed by runtime/contract/UI phases                |
| technical    | high    | retained AX identity, per-mutation guards, process death and leases                 |
| coupling     | high    | shared worker, sidecar lifecycle and legacy inputs in later phases                  |
| requirement  | low     | approved design and explicit sequential acceptance                                  |
| verification | unknown | toolchains available; TCC/fixture viability needs direct evidence                   |
| risk         | high    | desktop side effects; candidate remains an opt-in preview with no qualified targets |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                     | Severity | Source                              | Claim                                                                                      | Refuted by                                                      |
| --- | ------------------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| R1  | Target is moved to another window                 | high     | prior fresh review; upstream source | every permitted native mutation revalidates owning window                                  | reparent fixture mutates spectator                              |
| R2  | Executor outlives Host                            | high     | failure-injection lens; A12         | inherited lease stays held until execution ends                                            | successor acquires lease while child runs                       |
| R3  | Source/patch/artifact drift widens capability     | high     | STRIDE; existing staging patterns   | fixed source/patch/artifact receipts and profile                                           | tampered artifact passes build/probe                            |
| R4  | Headless tests are mistaken for native acceptance | high     | ADR-0020; evidence rules            | native gates are separately measured                                                       | P0 declared complete without A5/A12 qualification               |
| R5  | New engine breaks shared consumers/layering       | high     | architecture gate; prior review     | Native ownership and domain boundaries remain explicit; release qualification remains open | forbidden crate edge or unverified candidate enabled by default |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk  | Method                                                               | Independence   | Evidence | Coverage                            | Status  |
| --- | ----- | -------------------------------------------------------------------- | -------------- | -------- | ----------------------------------- | ------- |
| V1  | R3    | staging behavioral tests and corruption rejection                    | tool           | pending  | fixed build inputs                  | planned |
| V2  | R1    | failing regression then patched and inverse checks                   | tool           | pending  | final-window/partial-delivery logic | planned |
| V3  | R2    | actual CLI inherited lease, Host kill, successor refusal, child exit | real-env       | pending  | macOS process ownership             | planned |
| V4  | R1,R4 | disposable two-window AX fixture, retained-object reparent           | real-env       | pending  | real target/spectator behavior      | planned |
| V5  | R1,R3 | scoped upstream tests, fmt and clippy                                | tool           | pending  | compatibility patch                 | planned |
| V6  | R3,R5 | fresh patch review and architecture gate                             | fresh-reviewer | pending  | safety and integration placement    | planned |
| V7  | R4    | repeatable Native/candidate paired baseline                          | real-env       | pending  | P0 benefit qualification            | planned |
| V8  | R5    | P1-P4 behavior and native/UI acceptance after P0                     | tool           | pending  | remaining implementation            | planned |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                | Action    | Based on          | Reversal trigger                                            |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------- | ----------------------------------------------------------- |
| D1  | 2026-11-13 | Build isolated pinned compatibility patch before production routing                                                                                                                     | implement | O1,O2,O3,C1,C2    | final ownership or lifecycle cannot be enforced             |
| D2  | 2026-11-13 | Continue P1-P4 source implementation with verification deferred by explicit user direction; keep Native default and release qualification open                                          | implement | O1,O2,O3,C1,C2,G1 | resumed verification finds a contract or integration defect |
| D3  | 2026-11-13 | Repair source counterexamples from the focused architecture, stop, and restart [review](../reports/2026-11-13-agent-desktop-source-adversarial-review.md); retain verification deferral | implement | O4,C1,C2,G1       | later checks or native acceptance refute repaired contracts |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                      | From              | Why still open                                                                             | Next action                                                     | Status |
| --- | ------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------ |
| X1  | Native permission and final executable identity not qualified | V2,V4,Q1          | latest patch and integrated Host were not exercised; user deferred verification            | resume the disposable/native acceptance matrix later            | open   |
| X2  | Current source changes have no test/build/native acceptance   | V1,V3,V5,V6,V7,V8 | verification was explicitly deferred; code generation does not discharge these obligations | run scoped checks and Native/candidate baselines before release | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                     | How / when measured                                                           | Result                                                                  | Status  |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- |
| M1  | Reproducible safe P0 candidate             | pinned build, mutation guard, crash lease, native fixture and paired baseline | current patch exported and pinned; qualification deferred               | pending |
| M2  | Qualified switchable Cognia session engine | P1-P4 runtime and native/UI acceptance                                        | source wiring implemented; current runtime/UI/build behavior unverified | pending |
