# Evidence ledger: managed cloud desktop completion

- Status: building
- Lane: deep
- Created: 2026-10-29
- Updated: 2026-10-29 (WP1 committed; WP2/WP3/WP5 verified)
- Related: ADR-0233 amendment A1–A10; ADR-0234 amendment N1–N5; docs/plans/2026-10-29-managed-desktop-completion.md

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究现在云电脑的实现，看看缺口，确保功能完整，不能省略或者简化，确保连接和传输以及管理的合理性，explore可以使用haiku，有问题和我确认，不能省略或者简化，不能重复实现，注意代码整洁规范 /grill-me

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                              | State        | Basis                                                                                                                                                          | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | No production code writes `managed-desktops.json`; only tests call `save_registry`; provider keys can be stored only by operator `store-key`                                           | Verified     | grep of crates/src-tauri/cli/scripts at 9ee9de7667, 2026-10-29                                                                                                 | -          |
| O2  | `managed-desktop-release.json` is produced only as a CI artifact; no install path, so `release()` is None on real Hosts                                                                | Verified     | `managed_desktop_release.rs:27-44`, `images.yml:358-364`, 2026-10-29                                                                                           | -          |
| O3  | Qualification receipts are written only by the native operator with `--authorize-paid-smoke`; no RPC path                                                                              | Observed     | haiku explorer read of `smoke.rs`, `qualification.rs`, 2026-10-29                                                                                              | -          |
| O4  | Agent control, handoff execution and acceptance are blocked by compile-time constants                                                                                                  | Verified     | `managed_desktop_results.rs:17`, `control.rs:1103`, `managed_desktop_handoff.rs:116`, 2026-10-29                                                               | -          |
| O5  | No route from computer-use to a managed desktop: E2B lacks `gui`, registry has no managed branch, managed control is human-only                                                        | Observed     | haiku explorer, `connection-capabilities.ts:93`, `registry.rs:563-655`, `control.rs:1272,1453`, 2026-10-29                                                     | -          |
| O6  | Acceptance has no runner; `capture`/`complete` have no production caller; `agent_principal_id` has no production writer                                                                | Observed     | haiku explorer, results client + evidence.rs, 2026-10-29                                                                                                       | -          |
| O7  | Viewer polls one base64 screenshot per second over JSON RPC, also through the relay                                                                                                    | Observed     | `use-sandbox-desktop.ts:15`, viewer `:322-326`, 2026-10-29                                                                                                     | -          |
| O8  | Managed desktops and sandboxes are absent from the remote desktop list; adapter enum is `vnc`/`none` only; phones observe only                                                         | Observed     | `target.rs:30-33`, `remote-desktop-section.tsx:14-24`, viewer `:79-83,361`, 2026-10-29                                                                         | -          |
| O9  | Guest supervisor accepts fixed operations only; no confined exec, files or clipboard                                                                                                   | Verified     | `crates/cognia-desktop-guest/src/main.rs:25-47`, 2026-10-29                                                                                                    | -          |
| O10 | E2B key stored separately by ADR-0221 and ADR-0233 configs; template-build polling still private to sandbox-pool; base URL in three places                                             | Observed     | haiku explorer, `template.rs:239,311`, `provider.rs:218`, `remote-sandbox-draft.ts:41`, 2026-10-29                                                             | -          |
| O11 | Recipe-7 native P4 qualification passed on real E2B on 2026-10-17 in a private diagnostic Host                                                                                         | Observed     | `docs/plans/2026-10-16-managed-desktop-mmds-p4-verification.md`                                                                                                | -          |
| C1  | Shared working tree: explicit paths only, no stash/reset/checkout; foreign edits exist in sandbox viewer/hook files                                                                    | Verified     | CLAUDE.md §8; git status 2026-10-29                                                                                                                            | -          |
| C2  | Paid E2B smoke and enablement require separate explicit user authorization                                                                                                             | Verified     | user decision Q2, 2026-10-29                                                                                                                                   | -          |
| G1  | A user can configure, qualify, create, view, control, hand to an agent, accept and clean up a managed desktop from the product, on desktop, Web and phone, without the operator binary | Agreed       | grill Q1–Q23, 2026-10-29                                                                                                                                       | -          |
| G2  | No duplicate implementation: one frame data plane, one lease core, one qualification orchestration, shared E2B primitives                                                              | Agreed       | grill Q13–Q16, Q18, 2026-10-29                                                                                                                                 | -          |
| A1  | Guest screenshot latency allows ~6–8 fps while controlling                                                                                                                             | Unknown      | not measured; computer-server screenshot cost on E2B unknown                                                                                                   | -          |
| A2  | A shared `@cognia/plugin-ui` subpath can host the touch kit without breaking the plugin author boundary                                                                                | Hypothesized | plugin-ui already exports UI to plugins; not yet checked against `plugin:author-imports`                                                                       | -          |
| A3  | ADR-0221 secret can be read by reference under `cognia-remote-sandboxes` for the same owner/Host                                                                                       | Invalidated  | `remote-sandboxes.json` is Host-level with no owner; the copy is gated by `host.admin` + Host consent and limited to E2B secret-store credentials (2026-10-29) | -          |

## Problem frame

The managed desktop (ADR-0233) is built and natively qualified, but a user cannot reach it: configuration, release distribution and qualification exist only for the operator (O1–O3). Agent use and acceptance are locked by constants and lack a runner (O4–O6). The viewer path is a 1 fps poll that is absent from the remote desktop framework and limited on phones (O7–O8). Files, clipboard and shell need guest work (O9). Duplicated E2B pieces remain (O10). Solved means G1 and G2 hold, shown by targeted tests per package and the authorized real smoke in WP12. Out of frame: egress On/Allowlist, persistence/pause, region, live preview, cross-Host transfer, Lume.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| scale        | high   | 12 packages across Rust crates, companion RPC, renderer, guest image and CI                     |
| technical    | high   | delegation semantics over the shared lease, in-process frame adapter, confined guest operations |
| coupling     | high   | touches ADR-0233/0234/0221 code, plugin-ui, character/session binding, notifications            |
| requirement  | low    | 23 decisions confirmed by the user                                                              |
| verification | high   | real guarantees need paid E2B smoke and phone/relay smoke                                       |
| risk         | high   | spend, cross-owner access, sandbox escape via new guest operations                              |

## Risks

| ID  | Risk (impact)                                                                           | Severity | Source                     | Claim                                                                | Refuted by                                                                    |
| --- | --------------------------------------------------------------------------------------- | -------- | -------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R1  | Config/credential RPC lets a caller target another owner's account or leaks a key       | high     | ADR-0233 §1                | Owner/Host come only from authenticated context; keys never returned | a test or smoke where a forged owner argument or response contains the key    |
| R2  | In-app qualification or delegation lets an agent spend money or create desktops         | high     | ADR-0233 §4                | Only human admin actions spend or delegate                           | an agent/service principal reaches create, qualify or delegate                |
| R3  | Agent input bypasses human takeover or survives revocation                              | high     | ADR-0234 §2                | Takeover fences and revokes in-flight agent input within one call    | agent input accepted after takeover/revoke                                    |
| R4  | New guest exec/file/clipboard operations escape the workload boundary or reach metadata | high     | ADR-0233 MMDS amendment    | Every operation runs inside the full boundary                        | a qualification probe gets a metadata/private response or escapes containment |
| R5  | Frame stream ticket reaches another target or keeps streaming after revoke              | medium   | ADR-0234 §9 security tests | Tickets bound to session/target/mode; revoke closes stream           | cross-target attach or frames after revoke                                    |
| R6  | Frame stream adds guest load per viewer or drains billing via idle reset                | medium   | design Q15                 | One poller per desktop; viewing is not activity                      | capture count scales with viewers, or idle timer refreshed by viewing         |
| R7  | Shared E2B primitive extraction changes code-sandbox template behavior                  | medium   | ADR-0233 §1                | Code provider semantics unchanged                                    | FakeE2b contract test diff                                                    |
| R8  | Runtime gates enable a configuration with a stale receipt                               | high     | ADR-0233 §9                | Switches require a current receipt and drop on config change         | switch on after a config/recipe change                                        |

## Verification obligations

| ID  | Risk   | Method                                                                                          | Independence   | Evidence                                                                                                                                                        | Coverage                                                                                                                                                  | Status  |
| --- | ------ | ----------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Rust tests for forged owner, cross-owner copy, response/log redaction (WP3)                     | tool           | `cargo test -p cognia-automation --lib cua_sandbox::managed` 102 passed; `-p cognia-companion-rpc --lib managed_desktop` 51 passed (clean worktree, 2026-10-29) | owner/Host derived from principal; foreign owner sees nothing; copy only from a stored E2B secret-store credential; log redaction not separately asserted | passed  |
| V2  | R1, R2 | fresh-context review of config/qualify/delegate RPC authority                                   | fresh-reviewer | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V3  | R2     | Rust tests: agent/service refused for qualify, create, delegate (WP4, WP8)                      | tool           | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V4  | R3     | Rust tests for takeover/revoke/generation change plus real E2B agent takeover smoke (WP8, WP12) | real-env       | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V5  | R4     | recipe-8 workload qualification probes on real E2B (WP10, WP12)                                 | real-env       | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V6  | R5     | Rust tests for cross-target ticket and revoke-closes-stream (WP6)                               | tool           | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V7  | R6     | fan-out test (N viewers, one capture) and idle-timer test; measured rate in desktop smoke       | tool           | -                                                                                                                                                               | -                                                                                                                                                         | planned |
| V8  | R7     | sandbox-pool FakeE2b contract suite unchanged (WP1)                                             | tool           | `cargo test -p cognia-sandbox-pool --features e2b remote::e2b` 51 passed, `aaf3808e26`                                                                          | code-provider template naming/lookup untouched                                                                                                            | passed  |
| V9  | R8     | Rust tests: switch refused without receipt, dropped after config change (WP4)                   | tool           | -                                                                                                                                                               | -                                                                                                                                                         | planned |

## Decisions

| ID  | Date       | Decision                                                                                                                                                               | Action    | Based on       | Reversal trigger                                       |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ------------------------------------------------------ |
| D1  | 2026-10-29 | Scope A + D link; implement after audit; paid smoke separately authorized (Q1, Q2)                                                                                     | implement | G1, C2         | user changes scope                                     |
| D2  | 2026-10-29 | Config/credential RPC + form; explicit key copy from ADR-0221; release bundled in signed builds; in-app qualification; runtime gates (Q3–Q7)                           | implement | O1, O2, O3, O4 | E2B API change invalidating smoke                      |
| D3  | 2026-10-29 | `cognia-frames` adapter on ADR-0234 data plane, one poller per target, also for Docker; native targets projected; phone control via shared touch kit (Q8, Q9, Q14–Q16) | implement | O7, O8, A2     | A2 Invalidated or A1 shows rates unattainable          |
| D4  | 2026-10-29 | Host delegation for general computer use and acceptance; agent fenced-preemptible without a lease; acceptance child session with two tools (Q17–Q21)                   | implement | O5, O6         | review finds lease semantics unsound for remote agents |
| D5  | 2026-10-29 | Recipe 8 for exec/files/clipboard as Stage 2; egress On/Allowlist deferred to its own amendment (Q10, Q11, Q19, Q22)                                                   | implement | O9             | user requires egress in this round                     |
| D6  | 2026-10-29 | Merge E2B build request/polling/base URL into cognia-e2b; code provider semantics unchanged (Q13)                                                                      | implement | O10            | V8 fails                                               |

## Residual risks

| ID  | Residual                                                               | From        | Why still open         | Next action           | Status |
| --- | ---------------------------------------------------------------------- | ----------- | ---------------------- | --------------------- | ------ |
| X1  | Real frame rate and CPU on E2B unknown                                 | A1          | not measured           | measure in WP12 smoke | open   |
| X2  | Host-local concurrency limit is not account-wide across Hosts          | ADR-0233 §3 | accepted v1 limitation | label in UI           | open   |
| X3  | Egress Off makes the desktop offline for internet-dependent acceptance | D5          | deferred by decision   | separate amendment    | open   |

## Outcome

| ID  | Signal                                                                                         | How / when measured                    | Result | Status  |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | ------ | ------- |
| M1  | A user configures, qualifies and uses a managed desktop end to end without the operator binary | WP12 authorized real smoke             | -      | pending |
| M2  | Agent computer use and one acceptance complete on a managed desktop                            | WP12 authorized real smoke             | -      | pending |
| M3  | Phone controls a native target over relay                                                      | WP12 desktop smoke on the Huawei phone | -      | pending |
