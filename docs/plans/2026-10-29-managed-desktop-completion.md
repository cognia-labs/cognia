# Managed cloud desktop completion — phased implementation plan

**Date:** 2026-10-29  
**Status:** Decisions confirmed by the user on 2026-10-29 (grill session, Q1–Q23). Implementation not started. Real-provider smoke and per-configuration enablement need separate user authorization.  
**Decisions:** [ADR-0233 completion amendment A1–A10](../content/docs/en/adr/0233-a-managed-desktop-accepts-a-delivered-commit.md), [ADR-0234 native-target amendment N1–N5](../content/docs/en/adr/0234-a-remote-desktop-is-a-provider-binding-brokered-by-the-host.md).  
**Evidence ledger:** [`docs/evidence/2026-10-29-managed-desktop-completion.md`](../evidence/2026-10-29-managed-desktop-completion.md).  
**Scope:** the ADR-0233 E2B managed desktop and its connection path through the ADR-0234 framework. Local Docker CUA is in scope only where it shares the frame stream (WP6) and the remote-desktop projection (WP7). Lume and the ADR-0221 code sandbox are out of scope except for the shared E2B primitives (WP1).

## Why: gaps found by the 2026-10-29 audit

Read from the shared tree at `9ee9de7667`. Line numbers are from that read.

| Area        | Gap                                                                                                                    | Evidence                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Management  | No production writer of `managed-desktops.json`; key storable only by operator `store-key`                             | `managed/journal.rs:119` callers are tests only; `managed_desktop_operator.rs:196-210`                                          |
| Management  | Release manifest is a CI artifact only; `release()` is `None` on every real Host                                       | `managed_desktop_release.rs:27-44`; `.github/workflows/images.yml:358-364`                                                      |
| Management  | Qualification receipts only from the native operator (`--authorize-paid-smoke`); no RPC                                | `smoke.rs:316-336`, `qualification.rs:258,408`                                                                                  |
| Management  | Agent control, handoff execution and acceptance blocked by constants                                                   | `managed_desktop_results.rs:17`, `control.rs:1103`, `managed_desktop_handoff.rs:116`                                            |
| Management  | No template cleanup, no production credential rotation, no §5 alerts, `shutdown` uncalled, delete without confirmation | `service.rs` (no `templates.remove`), `managed_desktops.rs:254`, `managed-desktop-settings.tsx:384-400`                         |
| Transport   | Viewer polls one base64 screenshot per second over JSON RPC                                                            | `hooks/automation/use-sandbox-desktop.ts:15`, `sandbox-desktop-viewer.tsx:322-326`                                              |
| Transport   | Managed desktops and sandboxes absent from the remote desktop list; phones observe only                                | `components/devices/remote-desktop/remote-desktop-section.tsx:14-24`, `target.rs:30-33`, `sandbox-desktop-viewer.tsx:79-83,361` |
| Transport   | No file transfer, clipboard or reconnect for managed desktops                                                          | `sandbox-desktop-viewer.tsx:410-420`; `control.rs:~1014-1020`                                                                   |
| Agent       | No route from computer-use to a managed desktop; acceptance has no runner and `capture`/`complete` have no caller      | `connection-capabilities.ts:93`, `registry.rs:563-655`, `control.rs:1272,1453`, `managed-desktop-results-client.ts:184-202`     |
| Duplication | Two stored copies of an E2B key; template-build polling still private to sandbox-pool; base URL in three places        | `remote/e2b/template.rs:239,311`, `managed/provider.rs:218`, `lib/sandbox/remote-sandbox-draft.ts:41`                           |
| Guest       | Supervisor has fixed operations only; no confined exec, files or clipboard                                             | `crates/cognia-desktop-guest/src/main.rs:25-47`                                                                                 |

## Work packages

Two stages. **Stage 1** never touches the guest image, so it qualifies on recipe 7. **Stage 2** introduces recipe 8, which invalidates every recipe-7 receipt.

```
Stage 1
  WP0 docs (this plan, ADR amendments, ledger)            ── done with this plan
  WP1 shared E2B primitives ─────────────────────────────┐
  WP2 release manifest in signed builds ─────────────────┤
  WP3 config + credential RPC and form ──────────────────┼─▶ WP4 in-app qualification + runtime gates
  WP5 management + monitoring  (independent)             │        │
  WP6 cognia-frames stream ──▶ WP7 native targets + phone │        ▼
                                                          └─▶ WP8 agent delegation + managed routing ─▶ WP9 acceptance runner
Stage 2
  WP10 guest recipe 8 (exec/files/clipboard + qualification probes) ─▶ WP11 Host/UI files, clipboard, agent shell
Close
  WP12 preflight, desktop smoke, authorized real-provider smoke
```

Independent at the start: WP1, WP2, WP3, WP5 and WP6. They touch disjoint files, except that WP3 and WP5 both edit `managed-desktop-settings.tsx`. Run those two in sequence or split the component first. WP4 needs WP2 and WP3. WP8 needs WP4. WP9 needs WP8. WP7 needs WP6. WP11 needs WP8 and WP10.

Each package ships with:

- co-located tests (TS `*.test.ts(x)`, Rust in-file `#[cfg(test)]`);
- both split locales and `pnpm i18n:build`;
- a `cognia-next` changeset (minor), except WP0 and WP1, which are internal;
- a `wiring-auditor` pass.

Run only targeted tests. Never run a full suite or coverage. Check `df -h` before any cargo build. Follow the shared-tree rules in `CLAUDE.md` §8: explicit paths only, no stash/reset/checkout. Use a detached worktree when a file has foreign edits.

---

## WP1 — Shared E2B primitives (A9)

**Own:** `crates/cognia-e2b/src/{lib,exact}.rs`, `crates/cognia-sandbox-pool/src/remote/e2b/template.rs`, `crates/cognia-automation/src/cua_sandbox/managed/provider.rs`, `lib/sandbox/remote-sandbox-draft.ts`.

1. Move build-request submission, build-status polling (sandbox-pool `wait_build`) and the API base URL constant into `cognia-e2b`. Both providers call the shared functions.
2. Sandbox-pool keeps `template_name`, `build_steps`, `ensure_template` and its lookup semantics. The managed provider keeps exact-build provenance.
3. The TS draft default URL reads the same constant through the generated contract, or a single TS constant pinned by a test against the Rust one.

**Verify:** `cargo test -p cognia-e2b`; `cargo test -p cognia-sandbox-pool --features e2b remote::e2b`; `cargo test -p cognia-automation cua_sandbox::managed::provider`; `pnpm test -- lib/sandbox/remote-sandbox-draft.test.ts`. The `FakeE2b` contract tests must pass unchanged.

## WP2 — Release manifest in signed builds (A2)

**Own:** `crates/cognia-companion-rpc/src/managed_desktop_release.rs`, `crates/cognia-companion-rpc/src/managed_desktops.rs` (`install`), `src-tauri/tauri.conf.json` resources, `src-tauri/src/startup/services.rs`, `crates/cognia-server/src/main.rs`, `deploy/docker/Dockerfile.cognia-server`, `.github/workflows/images.yml`, a `scripts/build/` staging step.

1. Add `load_with_fallback(data_dir, bundled_dir)`: data-directory file first, then the bundled file. Both go through `validate_release`, and a malformed data-directory file is an error, never a silent fallback.
2. `install` gains the bundled directory: the Tauri resource dir on desktop, and a fixed image path on `cognia-server`.
3. Release CI downloads the `managed-desktop-release` artifact of the same commit into `src-tauri/resources/managed-desktop/` before bundling, and the server image `COPY`s it. When the artifact is absent the build still succeeds, and the Host stays dormant.
4. Settings shows which source supplied the release, and its digest.

**Verify:** Rust unit tests for precedence, invalid data-dir file, missing both and mismatched recipe; `node --test scripts/build/managed-desktop-release.test.mjs`; a test that the staging script fails closed on a digest mismatch.

## WP3 — Configuration and credential RPC + settings form (A1)

**Own:** `crates/cognia-automation/src/cua_sandbox/managed/{service,journal,contracts}.rs`, `crates/cognia-companion-rpc/src/managed_desktops.rs`, `protocol/companion-commands.json` (+ `pnpm companion-api:gen`), `lib/automation/managed-desktop-client.ts`, `components/settings/automation/managed-desktop-settings.tsx` plus a new `managed-desktop-config-form.tsx`, `i18n/messages/{en,zh-CN}/settings/managedDesktops.json`.

1. Service methods `save_config`, `delete_config`, `set_credential`, `copy_credential_from_remote_sandbox`, and `rotate_credential`. They live in the managed service, not the RPC crate, behind the existing per-Host lock and revision check (optimistic `expectedRevision`).
2. RPC arms require `host.admin` plus Host consent through the existing consent bridge (`install_host_consent_bridge`). Owner and Host come from the caller and never from arguments.
3. Copy credential reads the ADR-0221 secret by reference (`cognia-remote-sandboxes` service) only when the source provider has the same owner on the same Host. All keyring access goes through `secret_store`.
4. Delete refuses while live, pending-create, `destroyRetrying` desktops or templates exist. Rotate keeps cleanup authority (old generation secret retained until those resources are absent, then removed).
5. Form fields:
   - shape (CPU and RAM);
   - limits: concurrency, lifetime and idle, each capped at the v1 maximum;
   - plan binding: plan name, allowed seconds, confirmation date and source;
   - price: rate, currency, source and expiry, at most 30 days;
   - egress, fixed at `Off` with the unqualified label from A10;
   - isolation minimum.

   The key field is write-only. The form also offers a picker for "copy from code sandbox provider".

**Verify:** Rust tests: cross-owner refusal, forged owner argument, stale revision, limits above cap, invalid price/plan, delete with live resources, rotate keeps cleanup, copy refuses foreign owner, secret never in the response or logs. TS tests for the client and the form. Generator freshness: `pnpm companion-api:gen` followed by its check.

## WP4 — In-app qualification and runtime gates (A3, A4)

**Depends on:** WP2, WP3.  
**Own:** `managed/{smoke,qualification,service,control}.rs`, `crates/cognia-companion-rpc/src/{managed_desktops,managed_desktop_results,managed_desktop_handoff}.rs`, `crates/cognia-companion-rpc/src/bin/managed-desktop-operator.rs`, `lib/automation/managed-desktop-client.ts`, `lib/sandbox/connection-capabilities.ts`, settings components, i18n.

1. Extract the operator's smoke orchestration into a library function, so the operator binary and a new RPC `managed_desktop_qualify` share it. Do not copy it.
2. The RPC requires a human admin, a fresh quote for the smoke desktops and a separate template authorization, as §2 requires. It is single-use and idempotent per authorization. Progress goes through Host events. It can be cancelled, and cancelling still destroys desktops.
3. Replace the three constants with a per-configuration `enablement { manualGui, agentControl, acceptance }`, saved through WP3's config save. A switch can only be turned on while `qualified()` and the matching control/workload receipts are current. Each read revalidates them. Refusal codes are unchanged.
4. `connection-capabilities.ts`: the E2B row gains `gui` only when the Host reports `agentControl` enabled (Host truth, not a renderer flag).
5. UI: a qualify button with cost disclosure and a progress list, plus the three switches with dormancy labels when unavailable.

**Verify:**

- The operator and the RPC produce identical receipts (shared function, fixture provider).
- A forged switch without a receipt is refused.
- A config change after qualification turns the switches off.
- Agent or service callers cannot qualify.
- Cancelling mid-run destroys the desktops.
- The capability row follows Host state.

Test the dormant paths on all three axes (type, UI, test).

## WP5 — Management and monitoring (A7)

**Own:** `managed/{service,journal}.rs`, `managed_desktops.rs`, `src-tauri/src/startup/services.rs` shutdown hook, `crates/cognia-server/src/main.rs` shutdown, `lib/automation/managed-desktop-client.ts`, a new `lib/automation/managed-desktop-alerts.ts` → `lib/notifications/api.ts:emitNotification`, `managed-desktop-settings.tsx`, `managed-desktop-cleanup.tsx`, i18n.

1. Add `list_templates` and `delete_template` (`host.admin`). Deletion is refused while a template is in use, and the record is removed only after provider absence is observed. Template deletion keeps its own retry state in the journal.
2. Each reconcile tick computes the §5 alerts:
   - a resource past its deadline plus 60 seconds;
   - cleanup older than 10 minutes;
   - the oldest pending create or delete.

   Alerts are emitted as Host events with bounded, token-free fields, and the renderer turns them into notification-center entries, deduplicated per resource and kind.

3. The cleanup panel lists `destroyRetrying` desktops, their attempts, next retry and maximum billing exposure, next to the evidence-deletion queue.
4. Call `managed_desktops::shutdown` from desktop exit and `cognia-server` graceful shutdown.
5. Add a confirmation dialog to Delete, reusing the themed dialog primitives from `56f747a863`, not native `confirm`.

**Verify:** Rust tests: template delete in use, provider 404 versus timeout, each alert threshold with a fixed clock, shutdown cancels the worker. TS tests: alert mapping and dedupe, cleanup panel, delete confirm.

## WP6 — `cognia-frames` stream (N2)

**Own:** `crates/cognia-remote-desktop/src/{target,host,session,bridge,commands}.rs` and a new `frames.rs`, `crates/cognia-automation/src/cua_sandbox/{managed/control,desktop_session}.rs` (frame source trait impls), `crates/cognia-companion/src/ws_remote_desktop.rs`, `lib/remote-desktop/{stream,host-client}.ts`, `hooks/automation/use-sandbox-desktop.ts`, `components/settings/automation/sandbox-desktop-viewer.tsx`.

1. `Adapter::CogniaFrames` with an in-process `FrameSource` trait. The two implementations are the managed control plane and local CUA `desktop_session`. Bridge sessions for this adapter use the frame pump instead of a TCP upstream.
2. Frame encoding and the frame header are defined once in Rust, with a TS decoder and a shared fixture test. JPEG transcoding happens on the Host. Frames over 1 MiB lower quality, then downscale. Hash dedup.
3. One poller per target, fanning out to every viewer, with these rates:
   - about 6–8 fps while a human holds control;
   - about 2 fps when only observing;
   - 0.5 fps backoff after repeated identical frames;
   - stopped when no viewer is attached.

   Each viewer has a latest-only queue of one. Constants live in `frames.rs`.

4. The viewer hook opens a stream session and falls back to single-frame RPC only when the stream cannot open. Input keeps using the lease RPC with the header's frame ID and fence. Observation reconnects automatically with backoff; control is never resumed automatically.
5. Viewing does not touch `last_activity_at`.

**Verify:**

- Rust: header round-trip, size cap, dedup, rate selection, fan-out with N viewers equals one capture, backpressure drops stale frames, ticket for another target refused, revoke closes stream.
- TS: decoder fixture, hook fallback, reconnect without control resume.
- Audit rows for open, close and failure.

## WP7 — Native targets in the remote desktop list + phone control (N1, N3)

**Depends on:** WP6.  
**Own:** `crates/cognia-remote-desktop/src/{host,commands}.rs` (projection), `components/devices/remote-desktop/*`, `components/devices/sections/runtime-section.tsx`, `packages/plugin-ui/src/remote-desktop-touch/*` (moved from `plugins/remote-desktop-vnc/src/touch-*`), `plugins/remote-desktop-vnc/src/vnc-viewer.tsx`, `sandbox-desktop-viewer.tsx`, i18n.

1. Target listing merges projections from the CUA registry and the managed service: read-only, a `native` binding, plus Selkies for Selkies-built sandboxes. Mutating commands refuse projected IDs.
2. Move the touch input, controls and special-key bar into an `@cognia/plugin-ui` subpath export with injected labels. The VNC plugin and the host viewer both import it. Run `pnpm build:packages` and `pnpm plugin:author-imports`.
3. Phone viewer: trackpad by default, direct touch selectable. Take control is enabled on phones under the same `host.admin` lease.

**Verify:**

- Rust tests: the projection lists both kinds, mutations are refused, an observe-only device sees no control.
- Moved touch tests pass in their new home.
- VNC plugin tests stay green.
- Viewer test: phone control is enabled.

## WP8 — Agent delegation and managed routing (A5)

**Depends on:** WP4.  
**Own:** a new `managed/delegation.rs`, `managed/{control,service,journal}.rs`, `crates/cognia-automation/src/cua_sandbox/registry.rs`, `crates/cognia-automation/src/automation/cua_route.rs`, `managed_desktops.rs` (delegate/revoke/list RPC), `lib/sandbox/{session-runtime,binding}.ts`, `lib/automation/sandbox-target.ts`, `components/agents/editor/character-editor.tsx` (`ComputerUseTargetPicker`), a session-level target picker, i18n.

1. Journal-backed `Delegation { owner, host, desktopId, generation, grantee, mode, expiresAt, revision }`. Create needs a human with `host.admin`. Expiry is at most the desktop deadline. Destroy, generation change, account switch and revoke end it.
2. Add a managed branch to `CuaSandboxRegistry` connection resolution. `cua_route` carries an authenticated agent principal into `ManagedControl`. Add an agent path that reuses `ControlLeaseCore`'s agent guard and preemption epoch, exactly like `desktop_session.rs`. Every operation revalidates the delegation, the generation and the `agentControl` switch.
3. Agent operations update `last_activity_at`.
4. The renderer binds a running managed desktop as a session or character target. The picker filters to GUI-capable rows and writes the binding only after the Host returns a delegation. `session-runtime.ts` refuses a managed row with no live delegation, with no host fallback.

**Verify:**

- Rust: agent refused without delegation, after revoke, after generation change, while a human holds the lease or a takeover is pending; takeover revokes in flight and releases held input; expiry is never later than the deadline; agent cannot create, delete or delegate.
- TS: picker filtering, binding refusal paths.
- `tauri-rust-reviewer` for guards across `.await` and detached tasks.

## WP9 — Acceptance runner (A6)

**Depends on:** WP8.  
**Own:** `crates/cognia-companion-rpc/src/{managed_desktop_handoff,managed_desktop_results}.rs`, `managed/{handoff_service,evidence}.rs`, `lib/automation/{managed-desktop-handoff-client,managed-desktop-results-client}.ts`, a new `lib/claude/acceptance-builtin-tools.ts` (+ `lib/claude/permissions/acceptance-tool-rules.ts`), a new `propose_acceptance` tool beside it, `lib/chat/attached-session.ts` (reuse `createAttachedSession`), `components/settings/automation/managed-desktop-handoff.tsx` and a proposal card component, i18n.

1. Production handoff execution: Start creates the child run, desktop, handoff and `acceptance` delegation atomically per authorization. It sets `agent_principal_id` from the delegation, which is that field's first production writer.
2. The criteria editor (description, screenshot required) is included in the manifest digest. `propose_acceptance` prefills the criteria and produces a card with no spend authority.
3. Open the child session via `createAttachedSession` with an acceptance title and the source session's agent and model by default. Its capability grant adds `acceptance_checkpoint` and `acceptance_complete` only.
4. The tools call `capture` and `complete` under the delegated agent principal. The human branch of `capture` and `approve` remains available in the results UI.
5. Completion, cancellation, deadline or revoke ends the delegation and destroys the desktop. The parent run is never mutated and nothing merges.

**Verify:**

- Rust: `complete` refused without the delegation; a wrong `agent_principal_id` is refused; evidence caps hold; source run unchanged.
- TS: tool rules, card has no spend path, child session wiring, criteria digest.
- `pii-gate-auditor`, because the child session sends prompts.

## WP10 — Guest recipe 8 (A8, Stage 2)

**Own:** `crates/cognia-desktop-guest/src/{main,control,protocol,boundary,qualify,probe}.rs` and a new `operations.rs`, `crates/cognia-automation/src/cua_sandbox/image/*` (recipe bump), `managed_desktop_release.rs` (`RECIPE = "8"`), `scripts/build/managed-desktop-*`, `.github/workflows/images.yml`.

1. Supervisor operations: `exec` (argv, cwd, timeout, 1 MiB output), `file-read`/`file-write` (chunked, `openat` no-follow, contained to the workload home, 8 MiB per file and 32 MiB per session), and `clipboard-get`/`clipboard-set` (text, 1 MiB). They are accepted only on the root control socket and run inside the full workload boundary.
2. Workload qualification adds probes for these operations: metadata and private destinations refused, symlink/hardlink/special-file escapes refused, and descendants terminated on supervisor death.
3. Recipe 8 and image republish. The release manifest pins the new digest. Recipe-7 receipts read as stale.

**Verify:** guest unit tests and offline probe fixtures; image build in CI. Real qualification belongs to WP12, under authorization.

## WP11 — Files, clipboard and agent shell on managed desktops (A8, N4)

**Depends on:** WP8, WP10.  
**Own:** `managed/{control,provider}.rs` (operation calls through envd to the supervisor), `crates/cognia-automation/src/cua_sandbox/{registry,lifecycle_execution,file_transfer}.rs` (managed branch), `lib/sandbox/connection-capabilities.ts` (`workspaceRead`/`workspaceExec` from Host truth), `components/settings/automation/{sandbox-desktop-viewer,sandbox-file-transfer}.tsx`, i18n.

1. Human file upload/download and clipboard need `host.admin` and the lease, and record audit without content.
2. Agent shell and file tools route through the WP8 delegation to the same desktop.
3. Everything stays dormant on all three axes until a recipe-8 receipt exists.

**Verify:** Rust tests for limits, containment errors, lease and delegation refusals, audit fields; TS tests for capability gating and UI.

## WP12 — Close-out verification

1. Run the `preflight` skill over each package's diff. `pnpm audit:colocated-tests`, `pnpm audit:rust-architecture`, `pnpm lint:i18n`, `pnpm i18n:build:check`, `pnpm docs:build` (for the ADR amendments).
2. **Desktop smoke** (no spend), using the local Docker CUA:
   - frame stream rate and CPU;
   - observe-only reconnect;
   - phone control over relay on the Huawei test phone;
   - projected targets listed;
   - delete confirmation;
   - template list against a fake provider.
3. **Real E2B smoke**, only after the user authorizes the account, shape, TTL and estimated spend:
   - in-app qualification on recipe 7, then recipe 8;
   - manual GUI over the stream;
   - agent computer-use under delegation;
   - one acceptance from Start to verdict to approval to delete;
   - file, clipboard and exec on recipe 8;
   - TTL kill with the Host stopped;
   - template delete.

   Record measured frame rates and spend.

4. Enabling a configuration's switches for normal use is the user's call after step 3.

## Progress

- **WP1** committed `aaf3808e26` (implemented by Codex `gpt-6.1-sol`, reviewed; `cognia-e2b` 34, sandbox-pool `remote::e2b` 51, TS 20).
- **WP2** Host side done (`e086048016`): `load_installed` (data directory first, bundled second, an invalid data-directory manifest never falls back), `managed_desktop_release_status`, settings line. Bundling (Q24 decided: option a): the release is pinned in `src-tauri/resources/managed-desktop/` with a record of the guest sources it was built from; Tauri bundles that directory, the server image copies it to `/usr/share/cognia/managed-desktop/`, the Images artifact carries both files, and `pnpm audit:managed-desktop-release` fails on drift. No pin exists until the image is published again from current sources, which needs the user's separate authorization.
- **WP3** done: `managed/config_admin.rs` (save, delete, set, rotate, retired-key cleanup), copy from an ADR-0221 E2B secret-store credential inside the Host, the settings form. The Host dates plan and price confirmations with its own clock, so a client ahead of the Host's clock is never refused.
- **WP5** done: `managed/template_admin.rs` (template list/delete with retry, monitor), `cognia-e2b::delete_template`, `managed-desktop://monitor-changed` (empty payload; clients refetch the caller-scoped monitor), notification-centre alerts on every shell, desktop delete confirmation, worker shutdown on exit.
- **WP6** split: the Host frame pump, adapter and TS decoder are with Codex; registering the frame sources and the viewer/hook wiring stay here.

## Rollback

Every switch defaults off. Turning a switch off, or removing the release manifest, disables new work and keeps status, delete, reconciliation, template cleanup and evidence deletion working. Removing recipe 8 from the manifest returns exec, files and clipboard to dormant without affecting recipe-7 GUI use. The frame stream falls back to single-frame RPC when a stream cannot open.
