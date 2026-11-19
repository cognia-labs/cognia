# agent-desktop session engine

Implementation status: the source integration and optional packaging path are implemented; verification was deferred by the user on 2026-11-13. This is an optional preview, with no qualified release targets yet. Earlier cached binaries and fixture reports do not qualify the current patch.

## Ownership

- `integrations/agent-desktop.json` pins upstream v1.2.0, the source archive, and the Cognia patch. `patches/cognia-bound-window-v1.patch` is the reviewable upstream change; the disposable checkout is not a shipping dependency.
- `scripts/build/stage-agent-desktop-runtime.mjs` prepares fresh authenticated source, applies the authenticated patch bytes, builds an evaluation artifact, and records its source, patch, source-tree, and executable digests.
- `crates/cognia-automation/src/automation/execution.rs` owns Host admission, run revocation, final input checkpoints, and held-button cleanup coordination. The worker keeps its 64-entry queue, with at most eight queued calls per run; a weak-sender wakeup only wakes an idle worker, while cleanup is checked ahead of each queued request.
- `session_engine.rs` owns immutable boot selection and private Native window bindings. The original OS backend still captures windows and delivers explicit physical input. Vendor refs never enter a Native element resolver.
- `agent_desktop/` owns the fixed CLI grammar, JSON 2.6 parsing, private ref mappings, bounded streams, stdin text, inherited executor lease, and child ownership. It does not own permission policy or model registration.
- `cognia-sidecar` exposes a domain-neutral lifecycle port. The Tauri startup assembly supplies it; the platform crate does not import the automation domain. Native pending-run tokens are checked before send, and interruption, turn completion, disposal, and process-generation exit revoke their automation scopes.
- `engine_config.rs` stores restart-only selection with an independent file lock, generation, and revision CAS. Explicit Native-only recovery preserves a digest-bound backup and rotates generation. Legacy permission-settings saves cannot overwrite engine selection.

These files are separate because vendor protocol grammar, Host authorization, durable configuration, and OS input ownership have different responsibilities. Existing persistence and worker/session machinery are extended rather than replaced.

## Current action boundary

The candidate handles application-window snapshots and a narrow semantic subset:

| Request                                                                        | Executor                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Single left click on a qualified ref                                           | agent-desktop, headless                               |
| Set a control value                                                            | agent-desktop, text over stdin                        |
| `secondaryAction:toggle`                                                       | agent-desktop                                         |
| Focus the captured window                                                      | Native; observe again before input                    |
| Explicit pixel target                                                          | Native, using its saved window/focus/geometry binding |
| Other semantic operations, including typing by keys and control-specific focus | Explicit refusal; no automatic fallback               |

All candidate-session writes, including explicit Native Focus/pixel actions, require a live Host-sidecar run scope. Callers without that scope receive empty semantic and Native action lists. Existing granular Native APIs remain Native and use the shared fence. Remote/managed routes do not become local CLI routes. Run/window changes rotate lineage; revoked sessions release their private refs and capacity at worker cleanup.

Snapshots do not automatically activate renderer accessibility. If upstream requests application-wide activation, the patch preserves the readable tree as incomplete; tokenless absence/uniqueness claims remain unavailable. Final AX writes and preparatory scrolling check the actual owning window and process generation. Preparatory delivery is never downgraded to a retry-safe refusal.

The public element-handle shape is unchanged. Engine refs and Native window refs remain private. Optional `sessionEngine` and `delivery` metadata advertise the actual subset and distinguish delivery from application-level verification. Every candidate action requires a new observation afterward and forbids replay.

Delivery metadata also covers the Native and remote adapters. A Native tree change or a remote input acknowledgment is `deliveredUnverified`, projected conservatively as `status: unknown`; it does not prove the requested effect. The delivery executor (`native`, `agentDesktop`, or `remote`) is separate from the two selectable local engines. Stop notifications carry an epoch so a delayed `stopping` event cannot overwrite a settled result for the same stop.

The CLI journal records a private operation intent before process creation and adds the owned PID/group after spawn. Standard output is limited to 8 MiB and standard error to 64 KiB. Cleanup has a bounded wait; uncertain group or stream closure leaves the executor quarantined. Recovery does not signal stale PIDs from a previous boot.

## Build and selection

Ordinary desktop builds keep Native and omit the candidate. Tauri preparation calls:

```sh
pnpm agent-desktop:prepare
```

An Apple Silicon macOS preview build can opt in explicitly:

```sh
COGNIA_AGENT_DESKTOP_PREVIEW=1 pnpm tauri build
```

Preparation stages the executable, receipt, license, and digest under `src-tauri/resources/agent-desktop/`. The Rust build embeds the digest. Packaged runtime authenticates that fixed bundled source; development uses the fixed checkout resource because dev builds omit bundle resources. Each owner creates a private read-only executable snapshot from the authenticated bytes, preventing app updates from replacing its launch path. Runtime never searches `PATH`, accepts an executable from settings, or downloads a replacement. Signing, notarization, and the installed app's TCC identity still require release acceptance.

In Settings → UI Automation → Behavior, choose the local application-session engine. Saving only changes `desiredEngine`; the current worker and its bindings keep their boot-time engine until restart. Missing or incompatible candidate builds refuse the selected session path rather than silently switching to Native. Save Native and restart to return to it.

Damaged settings expose Restore Native when the file can be read safely. Recovery preserves its bytes; an invalid boot selection stays unavailable until restart. If the previous executor still holds the lease, wait for it to exit and restart to retry recovery. The worker does not swap engines or bindings in place. Persisted disabled permissions also initialize the execution fence as disabled.

The get/set/probe commands are `client.local` and internal only. Paired HTTP, WebSocket, WebRTC, web, and headless clients cannot switch or launch this local engine. Probe only checks the fixed version/profile and permissions; it does not request permissions or issue input.

## Deferred acceptance

No tests, application builds, or native fixture runs were performed after the user requested deferral. Source formatting and command/message generation are not runtime acceptance.

Run the staging tests with `node --test scripts/build/stage-agent-desktop-runtime.test.mjs`. The native harness requires a binary and source tree matching the same receipt, and uses only disposable fixture windows. Regenerate the candidate before using it. The old `.cache/agent-desktop-p0/staged.json` belongs to an earlier patch.

```sh
pnpm agent-desktop:test:native --binary <candidate> --source <source-tree> --target-dir <cargo-target-dir>
```

Before release, run the approved A1–A16 matrix, Native regression checks, the current upstream suite, local command/UI checks, and paired Native/candidate performance baselines. In particular, validate legacy entry points, external callers' explicit refusals, held-input cleanup, helper/process lifetime, partial renderer trees, and signed-package permissions. This implementation does not establish performance gains or production readiness.

The [source adversarial review](../../docs/reports/2026-11-13-agent-desktop-source-adversarial-review.md) records repaired counterexamples and remaining acceptance boundaries.

The [duplication review](../../docs/reports/2026-11-13-agent-desktop-duplication-review.md) records shared helpers, local consolidations, and intentionally separate authority/lifecycle contracts. Verification remains deferred.
