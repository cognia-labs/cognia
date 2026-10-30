# Browser performance changes: adversarial review

Follow-up: the user authorized all four repairs. Implementation, regression results and bounded real before/after data are recorded in [the repair report](2026-10-29-browser-four-fixes.md). The findings below describe the pre-repair artifact; they are not the current unresolved status.

Date: 2026-10-29. Scope: the current local Chromium lifecycle, runtime diagnostics, sandbox stream health and observer screenshot suppression. Three independent reviewers received source paths and behavior contracts without the implementation rationale. Findings were reconciled against source and bounded reproductions. External model CLIs were skipped under the user's earlier choice.

This review changes documentation only. Product fixes, deployment and new performance gains are not claimed.

## Findings

### F1 — P1: a stalled CDP teardown blocks every replacement stream

Locations: `services/workspace-runtime/src/browser-service.mjs:2893-2898,2924-2932`; native timeout boundary: `crates/cognia-local-browser/src/client.rs:229`.

`releaseScreencast` awaits both `Page.stopScreencast` and CDP detach without a deadline. That promise occupies `session.screencastTask`, which serializes subsequent starts/stops. If either operation never settles while the runtime stays alive, a replacement stream cannot start. The HTTP/Rust deadline abandons its request but does not settle this JavaScript promise. Meanwhile the first stop already cleared `screencastRequest`, so retrying the same consumer's stop returns `false` without waiting for or releasing the blocked task.

A controlled probe against the actual service held the old CDP stop, retried that consumer's stop, then requested a replacement. It observed:

```json
{
  "stopRetry": false,
  "oldStopSettled": false,
  "replacementSettled": false,
  "attachedCdps": 1,
  "currentRequest": "new",
  "currentCapture": null
}
```

The parent also reproduced both a blocked stop and a blocked detach using the actual service and a synthetic session/CDP. In both cases releasing the barrier let the replacement attach immediately. This is deterministic injected-failure evidence, not a measurement of how often Chromium stalls in production.

Reproduction: `rtk proxy node .cache/round3-local-audit/teardown-repro.mjs`.

Required follow-up: bound and cancel teardown, isolate obsolete CDP work and make the serialized lane recover while preserving consumer/generation checks. Add never-settling stop and detach regressions, including late completion after a replacement. Input must not be replayed during recovery.

### F2 — P2: iframe revalidation leaves public health at `open`

Locations: `hooks/automation/use-sandbox-desktop-stream.ts:188-193`; consumer: `components/settings/automation/sandbox-desktop-viewer.tsx:118`.

On iframe load and visibility return, `observe()` resets its internal readiness and deadlines but does not publish `connecting`. The viewer continues deriving `streamHealthy=true` from the previous `open`. Following an iframe reload that produces no fresh health report, the observer continues suppressing screenshots and the Take control eligibility still uses stale stream readiness until the watchdog fires.

A probe imports/transpiles both actual hooks, using React renderHook, jsdom, a fake clock and external RPC fixtures. The parent reran it:

| Stage                          | Public status | Total captures | Captures since reload |
| ------------------------------ | ------------- | -------------- | --------------------- |
| Verified healthy               | open          | 2              | —                     |
| Iframe load without new health | open          | 2              | 0                     |
| 14 seconds later               | open          | 2              | 0                     |
| 15-second watchdog             | error         | 3              | 1                     |

This is a known invalidation of the current document's handshake, distinct from a verified idle display that still sends healthy heartbeats. It does not demonstrate a bypass of native lease/fence/proof checks.

Required follow-up: publish revalidation state immediately and resume auxiliary capture until the current iframe is verified again. Cover reload and visibility return, successful revalidation and missing reports; retain the valid-controller lease behavior on auxiliary screenshot RPC failure.

Reproduction: `rtk proxy node .cache/round3-desktop-audit/observe-reset-repro.cjs`.

### F3 — P2: diagnostic loss and truncation are invisible in DevTools

Locations: producer `services/workspace-runtime/src/browser-service.mjs:70-93`; shared types `packages/plugin-contract/src/lib/browser/protocol.ts:111-125`; consumers `components/browser/browser-devtools-panels.tsx:66-78,108-123`.

The runtime now emits `droppedBefore` and `truncated`. Engines and the hook retain these fields, but the shared interfaces omit them and the Console/Network panels render only the clipped text/URL. Closing or hiding DevTools while a page produces more than the budget, then reopening it, presents partial history as though it were complete. A line clipped at 4096 characters has no visible truncation indication.

Existing runtime tests confirm the metadata and bounds, but consumer tests never assert that a user can see the loss. Required follow-up: add the optional shared fields, localized loss/truncation notices and end-to-end consumer behavior tests. Keep the retention limits and credential redaction.

### F4 — P2: an obsolete stream-claim reply releases a newer control lease

Location: `components/settings/automation/sandbox-desktop-viewer.tsx:109-110`; stale-reply result: `hooks/automation/use-sandbox-desktop-stream.ts:258`.

The viewer starts `claimStream(lease)` asynchronously and releases the current desktop lease whenever the returned value is false. The stream hook correctly returns false for an obsolete generation, but the viewer does not check whether the lease that started that request is still current. A user can release control while claim A is pending, acquire lease B and finish its stream claim, then receive A's stale response. A's callback releases B.

A parent-rerun probe renders the actual viewer and both hooks, replacing only external I/O and UI primitives. It observes control for lease-3/fence3 after releasing lease-2/fence2; resolving the first pending claim changes the viewer to readOnly and invokes release for lease-3/fence3. This is an unwanted loss of valid control, not evidence of unauthorized input or a weakened native fence.

Required follow-up: bind each completion to the initiating lease/token/fence and current connection lifecycle. Test both late success and failure after release/reacquisition, retaining the rule that a genuine failure of the current claim releases that current lease.

Reproduction: `rtk proxy node .cache/round3-desktop-audit/lease-race-repro.cjs`.

## Rejected concerns and evidence boundaries

- **Object-log content regression: rejected.** Actual Chromium 153.0.8010.12 baseline/current comparison produced identical `level/text` for six nested-object, cyclic-object, Error, formatting and secret examples. Timestamps naturally differ. The removed wrapper previously forwarded original arguments; its extra serialization served an unconsumed buffer. Evidence: `.cache/round3-runtime-review-2026-10-29/object-log-comparison.json`.
- **Old overlay on a reattached user-Chrome document: unsubstantiated.** The inspected path creates a fresh agent window/tab and installs initialization scripts. No affected current caller was found.
- **Infinite cleanup retry by itself: not a separate defect finding.** Retaining consumer-scoped cleanup until confirmation or runtime-generation exit is deliberate. F1 identifies the concrete unresolved-promise failure instead.
- **Upstream silence remains a health-protocol limit.** The guest intentionally treats no new chunks on an idle display as healthy. A still-connected producer that stops sending is not distinguishable from an idle desktop using those messages alone. No live guest failure demonstrating that condition was available, so it is carried as a limitation, not a confirmed incident cause.

The previous round's measured service/page-script/overlay hashes still match current source. Its retained-JSON and synthetic object-log task improvements are not invalidated by these findings. They do not establish whole-application RAM savings, real Docker encoding/CPU gains or WKWebView end-to-end latency.

Docker availability was rechecked on 2026-10-29: the Colima socket `/Users/bytedance/.colima/default/docker.sock` is absent. No daemon, container or existing native user session was started, replaced or navigated. Live guest/native recovery and performance acceptance remain open.

## Checks in this review

- Existing focused Jest suites: **3 suites / 55 tests passed** (`use-sandbox-desktop`, `use-sandbox-desktop-stream`, `browser-devtools-panels`). Their green result does not cover F1-F3.
- Focused runtime diagnostics/privacy tests: **4 passed**.
- Deterministic hook invalidation, viewer stale-claim and service teardown fault probes reproduce F2/F4/F1; real Chromium content comparison rejects the object-log concern.
- No new coverage, broad type/lint/build or full native tests were run for this documentation-only review. Prior round gate results remain dated evidence rather than newly executed checks.

Prioritize F1, then F4/F2, then F3. Four actionable findings remain open. Add the missing failure/consumer regressions before changing the implementation, and repeat real Docker/native acceptance when the intended guest is available.
