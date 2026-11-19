# Evidence ledger: artifact support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-18
- Related: [ADR-0158](../content/docs/en/adr/0158-artifacts-and-canvas.md)

The 2026-11-18 industry comparison and adversarial recheck record the current
checkout. The recheck supersedes the earlier A01–A08 dispositions. The November 8 inventory describes that day's baseline before the
intervening fixes.

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在对右侧产物区的支持情况，看看存在什么bug或者缺口

2026-11-18 follow-up

> 帮我分析一下，看看现有的右侧产物区域，或者存在什么问题，并且对照业内的优秀实践

> 做一次对抗性审查，逐项验证问题是否真实、影响范围有没有夸大，再查查有没有遗漏，

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                     | State    | Basis                                                                                                 | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| O1  | ArtifactWorkspaceDock is mounted in desktop-chat-workspace and app-shell-mobile; it owns artifact, workspace, browser and side-chat surfaces. | Observed | Checked-out runtime call sites, 2026-11-08.                                                           | -          |
| O2  | CodeGraph is installed but its repository index is not initialized.                                                                           | Verified | `rtk proxy codegraph status`, 2026-11-08.                                                             | -          |
| G1  | Inventory current support and identify actionable bugs and gaps.                                                                              | Agreed   | Explicit user request, 2026-11-08.                                                                    | -          |
| C1  | Preserve concurrent work; audit behavior without production-code changes.                                                                     | Verified | Shared-tree instructions and initial git status, 2026-11-08.                                          | -          |
| Q1  | Current support and failure modes are mapped below.                                                                                           | Answered | Current source, refreshed 560-test baseline, adversarial probes and reconciled inventory, 2026-11-08. | O1         |
| Q2  | Chromium can exercise an isolated real preview component/runtime; no packaged Tauri or physical Capacitor device was exercised.               | Answered | Chromium 153.0.8010.12 browser probe and environment discovery, 2026-11-08.                           | -          |
| O3  | Fresh/partial artifact settings can crash fenced-content auto-creation.                                                                       | Verified | Actual DEFAULTS, event call shape and detection-store-probe.ts; F1 below, 2026-11-08.                 | -          |
| O4  | Auto-created artifacts have no projectId, remain visible in another project's All list and survive origin project purge.                      | Verified | Real store/filter/purge probe; F2 below, 2026-11-08.                                                  | -          |
| O5  | Preview failure/recovery and Retry have observable lifecycle defects.                                                                         | Verified | Three failing component assertions plus real Chromium component/runtime probe; F3 below, 2026-11-08.  | -          |
| O6  | Background revision and narrow browser reveals affect the foreground conversation.                                                            | Verified | Four failing dock assertions and real plugin caller trace; F5/F6 below, 2026-11-08.                   | -          |

| O7 | Independent review found browser-origin execution and account-transition contamination/durability failures. | Verified | Three fresh-context reviewers and bounded real-runtime/store/bridge probes, 2026-11-08; B01–B03. | - |
| O8 | Canvas toolbar document creation does not switch the shell to Canvas. | Verified | Actual hook/store test plus desktop/mobile shell mount gates, 2026-11-08; B19. | - |
| C2 | Complete this report without an additional cross-model invocation. | Verified | User explicitly selected no additional cross-model review, 2026-11-08. | - |
| Q3 | Does an explicit artifact reference grant cross-project by-ID access? | Answered | User decision 2026-11-09: no — by-ID read/update/capture/delete/open is isolated to the calling conversation's project; implemented in 9f08323000. | - |
| G2 | Re-evaluate the right-side artifact lifecycle and prioritize gaps against comparable documented workflows. | Agreed | 2026-11-18 follow-up request. | - |
| O9 | The artifact module has a series of fixes after the November 8 audit. | Observed | Relevant path history at 8991a9d7be, 2026-11-18. | - |
| H1 | Switching artifact tabs can discard the unsaved artifact editor buffer. | Verified | A01 in a keyed component probe with the real tab strip, panel, hook and store, 2026-11-18. | - |
| G3 | Adversarially re-evaluate A01–A08, calibrate severity to demonstrated impact and surface missed defects. | Agreed | 2026-11-18 follow-up request. | - |

## Problem frame

Follow-up adds an independent adversarial review and a reconciled complete
inventory within the audit scope. The user chose same-model review only.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Under G1 and C1, audit entry points, supported types, editing/review/export,
session lifecycle, persistence and platform differences. Each finding needs a
trigger, impact, owning source and an explicit evidence limit. Success is an
implementation-backed support matrix and prioritized reproducible defects (M1).
Production fixes and publishing are outside this audit.

## Complexity profile

Adversarial triage remains audit-only; discovered production risks include
browser-origin execution and account-transition data durability.

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| scale        | medium | Dock UI, detection, store, persistence, preview runtime and export.                             |
| technical    | medium | Sandboxed frames, JSX transforms, plugin renderers and split layouts.                           |
| coupling     | high   | Shared browser/desktop/mobile UI and session/account state.                                     |
| requirement  | low    | Investigation requested, no prescribed cause or implementation.                                 |
| verification | high   | Logic runs headlessly; packaged Tauri and physical-device claims require separate environments. |
| risk         | low    | Audit-only with isolated fixtures and cache output.                                             |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                 | Severity | Source                                                  | Claim                                                                       | Refuted by                                                       |
| --- | ------------------------------------------------------------- | -------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| R1  | A component exists but users cannot reach it.                 | medium   | Cognia risk catalog: dormant wiring                     | Support claims trace to mounted runtime paths.                              | Exported components have no live caller.                         |
| R2  | Green tests conceal broken previews or exports.               | medium   | ADR-0158 frame CSP and live-preview export constraints  | Baselines and independent counterexamples distinguish support from failure. | A focused reproduction contradicts a support claim.              |
| R3  | Context changes show or overwrite the wrong artifact state.   | high     | ADR-0158 persistence invariants; failure-injection lens | Scope is checked across detection, tabs and storage.                        | Switching session/project leaks content or drops intended state. |
| R4  | Desktop-only behavior is presented as cross-platform support. | medium   | Cognia risk catalog: three shells                       | Platform claims remain within actual evidence.                              | Browser tests are treated as packaged/mobile proof.              |

| R5 | Audit conclusions overstate security or validate unreachable mock-only failures. | high | Fresh-context adversarial reviewers; STRIDE/account-boundary lens | Inventory distinguishes observed behavior, intended contracts and evidence limits. | A claim depends on a UI path prevented by real mount keys or on an undocumented authorization assumption. |
| R6 | Users can lose edits or misread the saved or selected revision during ordinary dock navigation. | high | ADR-0214 per-task memory, editor lifecycle and version UI | Tab selection preserves in-progress edits and the history reflects a successful save. | A tab round trip drops dirty text or a saved entry is absent from the visible history. |
| R7 | The comparison misses existing Cognia capabilities or overstates competitor availability. | medium | Product documentation and current owning callers | Each recommendation maps a documented interaction to a current Cognia behavior. | A recommendation duplicates a live feature or relies on obsolete product documentation. |
| R8 | Ordinary routing or a concurrent change can discard draft text, alter another conversation's view or disappoint an export expectation. | high | ADR-0158, ADR-0214 and the mounted authoring/dock/export paths. | Close, edit, restore and export act on the resource and revision the user sees. | A repeatable control path shows visible divergence, silent replacement or lost draft. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk        | Method                                                                 | Independence | Evidence                                                                                                                                                                                     | Coverage                                                                                                                                             | Status |
| --- | ----------- | ---------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1,R3       | Trace mounted entry points, creation/detection, storage and lifecycle. | subagent     | Independent read-only detector/store and dock sweeps; owning sources linked in the findings.                                                                                                 | Current source wiring, no real provider.                                                                                                             | passed |
| V2  | R2          | Run focused existing preview, adapter, export and panel tests.         | tool         | 13 suites, 560 tests passed; commands and result artifacts below.                                                                                                                            | Current headless regression coverage, no coverage collection.                                                                                        | passed |
| V3  | R2,R3       | Execute bounded counterexamples for candidate defects.                 | tool         | Real-module probe reproduced F1/F2/F8/F9; four cached suites contain 10 failed expected-behavior assertions for F3–F7.                                                                       | Synthetic fixtures; expected failures establish defects, not fixed behavior.                                                                         | passed |
| V4  | R4          | Inspect browser environment and run feasible isolated UI checks.       | real-env     | `rtk proxy node .cache/artifact-support-audit/browser-probe.mjs`; Chromium 153.0.8010.12 confirmed initial render, stale error/capture rejection, blank Retry and unreported import failure. | Actual preview component and bundled frame runtime; outer stores/UI/localization/non-React renderers isolated. No full-app/native/device acceptance. | passed |
| V5  | R1,R2,R3,R4 | Check final ledger, references, diff and task-owned paths.             | tool         | Ledger checker and scoped Prettier check passed; final status shows only this ledger as task-owned tracked output.                                                                           | Audit deliverable integrity; concurrent changes preserved.                                                                                           | passed |

| V6 | R1,R2,R3,R5 | Fresh-context adversarial review plus caller/key/contract reconciliation. | fresh-reviewer | Three independent reviewers; rejected cross-artifact overwrite and Worker reorder; Q3 retained as open. | Data, previews/exports and dock routing; same model, no device acceptance. | passed |
| V7 | R2,R3,R5 | Refresh baseline and run current boundary/runtime counterexamples. | tool | 13 baseline suites/560 tests passed; 14 expected-contract assertions failed with Q3/DG06 explicitly classified; observation probes reproduced current bad states. | Current source; selected outer DB/UI services mocked, actual committed frame runtime in Chromium. | passed |
| V8 | R1,R4,R5 | Validate reconciled inventory, links, formatting, ledger and scoped git status. | tool | Final ledger checker and scoped Prettier/link/status checks recorded in task tools. | Report only; no production changes or claim of a green product gate. | passed |
| V9 | R2,R6 | Check draft, history, handoff and keyboard interaction in isolated components. | tool | 4 passed observation probes in `authoring.probe.test.tsx`; 11 existing Jest suites, 581 passed. Chrome 147 Storybook reproduced the local Close and stale history UI. | Real components and stores with isolated shell and editor leaf mocks, plus browser Storybook fixtures. | passed |
| V10 | R4,R6 | Exercise desktop-width and narrow browser dock scenarios. | real-env | Playwright discovered 7 cases; dev-server staging exited 1 at Host authoring kit ABI mismatch before any test ran. | Full application Chromium tests remain pending. | blocked |
| V11 | R7 | Read official comparator sources and trace each mapped Cognia entry point. | self | Official Claude, OpenAI, Google, VS Code and WAI-ARIA pages mapped in the follow-up. | Documented behavior and availability, without comparative usability measurement. | passed |
| V12 | R5,R6,R7,R8 | Fresh-context review of three owner paths, with source reconciliation per A01–A08 plus newly reported candidates. | fresh-reviewer | Three in-repo findings sets, reconciled in the adversarial section. | Authoring and history, dock routes, preview and delivery. Optional external review was offered. | passed |
| V13 | R6,R8 | Run current behavior probes and positive controls on the interactions supporting any high-priority claims. | tool | 12 existing suites and 488 tests passed. Observation probes: main 10, authoring 13, Dock 12. Chrome Storybook plus isolated browser byte and pixel probes. | Targeted checks, including positive controls, E2E blocked as in X6. | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                    | Action   | Based on          | Reversal trigger                                              |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------- |
| D1  | 2026-11-08 | Audit mounted behavior before proposing changes; use source search because CodeGraph has no index.          | diagnose | G1,C1,O1,O2       | User changes scope or runtime evidence contradicts the frame. |
| D2  | 2026-11-08 | Report reproduced failures with repair priorities; no implementation is needed to answer the audit request. | diagnose | G1,C1,O3,O4,O5,O6 | A reproduction is invalidated or the user requests fixes.     |

| D3 | 2026-11-08 | Re-enter discovery to challenge the earlier report and normalize confirmed defects, gaps and unresolved semantics. | diagnose | G1,C1 | User changes audit scope. |
| D4 | 2026-11-08 | Publish the reconciled inventory within this report; retain issues and native validation as open, with no fixes. | diagnose | G1,C1,C2,O7,O8 | A reproduction is invalidated, Q3 is resolved or user requests implementation. |
| D5 | 2026-11-18 | Re-enter discovery after intervening fixes and inspect authoring, return navigation and delivery as one user journey. | diagnose | G2,O9 | A current reproduction or current official documentation contradicts the comparison. |
| D6 | 2026-11-18 | Re-enter at source and behavior verification rather than treating the initial priorities as accepted. | diagnose | G3 | A review identifies a reachable counterexample or a change in intended contract. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                      | From  | Why still open                                                             | Next action                                                                                             | Status |
| --- | --------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| X1  | November 8 defect list awaited production fixes.                                              | R2,R3 | The November 18 mapping records commits addressing all 22 prior defects.   | Native and full-app acceptance are carried in X2 and X6.                                                | closed |
| X2  | Packaged Tauri, physical Capacitor, real-provider and complete app acceptance are unmeasured. | R4,V4 | Only source, headless checks and isolated Chromium preview were exercised. | Run relevant native/device/provider flows when implementing fixes; do not extrapolate Chromium results. | open   |
| X3  | November 8 settings flags lacked runtime consumers.                                           | R2    | The notification is consumed and the retention toggle was retired.         | Refer to 8cb69fd501 and 32e98f9b30.                                                                     | closed |

| X4 | Explicit cross-project artifact-ID policy was unresolved. | Q3,R5 | 9f08323000 applies the project isolation decision to by-ID access. | Keep the by-ID and list contract aligned when adding callers. | closed |
| X5 | New security/account-transition findings have bounded reproduction scopes. | R3,R5,V7 | Browser proof uses synthetic same-origin data; account/bridge proofs do not drive the full native account-switch UI. | Fix with current regressions, then verify deployed browser CSP and real account transitions in each affected shell. | open |
| X6 | Full-app Chromium acceptance was blocked. Tauri and Capacitor device behavior is unverified. | V10,R4 | The plugin authoring-kit ABI mismatch stopped app startup. Isolated probes cover narrower behavior. | Use a source and kit pin that match, rerun the two Chromium files, then drive artifact editing, resize, Canvas navigation and export on the supported shells. | open |
| X7 | Draft-loss incidence and the impact of the changed entry points are unmeasured. | H1,R6,R7 | Synthetic fixtures establish reachable component behavior. Users and product telemetry were outside this audit. | Measure draft recovery, time to preview and successful export in the affected flows after remediation. | open |
| X8 | Limits of draft, focus, and export counterexamples. | R8,V12,V13 | Actual components are exercised with a lightweight editor mock, some keyboard behavior is jsdom-only, and byte probes substitute native save. | Retain baseline controls and verify affected real shells alongside a repair. | open |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                  | How / when measured                                                                    | Result                                                                                                                 | Status |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Deliver a current support map and prioritized actionable findings with evidence limits. | This audit and final response, 2026-11-08.                                             | Reconciled inventory: 22 confirmed defects, six implementation gaps and one unresolved contract question.              | met    |
| M2  | Deliver refreshed diagnoses and a source-backed industry comparison.                    | Current source, targeted observation probes and first-party documentation, 2026-11-18. | Four reproduced defects, one source-confirmed label mismatch, three product gaps, and prioritized acceptance criteria. | met    |
| M3  | Verify each issue's existence and limits, and capture any additional issue classes.     | Revised findings with controls and source owners.                                      | A01–A08 reconciled individually, ten grouped additional findings and bounded candidates recorded.                      | met    |

## Current support

This is a unified workbench mounted by
[`desktop-chat-workspace.tsx`](../../components/desktop/desktop-chat-workspace.tsx)
and [`app-shell-mobile.tsx`](../../components/app-shell-mobile.tsx), not just a
standalone artifact preview. A new ledger is necessary because no existing open
ledger covered this artifact/dock audit. No production source or tracked unit
test was edited, and nothing was committed or pushed by this task.

| Area                | Current implementation                                                                                                                                                         | Limits                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact types      | `code`, `document`, `html`, `react`, `svg`, `mermaid`, `chart`, `math`, `jupyter`.                                                                                             | Office-style structured models use plugin renderer/native export contracts; they are not additional built-in artifact types.                                                                   |
| Creation            | Explicit agent tools, fenced-content detection, manual creation, plugin API and workflow nodes. Source fingerprints deduplicate auto-created content.                          | Heuristics have configuration and scoping bugs F1/F2/F8/F9. Background ordinary-chat detection is skipped at `claude-chat-events.ts:1836`; explicit tool creation is a separate route.         |
| Preview             | Static HTML/SVG, offline React runtime + JSX worker, charts/Mermaid/math, Markdown, code and notebook renderers.                                                               | React only bundles React-related imports. Interactive HTML is default-off and requires a per-artifact grant; external script loading is deliberately dropped.                                  |
| Authoring/review    | Source editing, versions, AI revision proposals, hunk review, comments, selection and Canvas-document creation; toolbar navigation fails (B19).                                | Preview recovery is defective (F3). No real-provider edit/review flow was run.                                                                                                                 |
| Export              | Raw source for all built-ins; HTML/SVG source formats; PNG/PDF for supported visual types; text PDF for code/document/notebook; cross-platform saver.                          | React and chart/Mermaid/math image export require a live mounted preview. Plugin models retain plugin-owned export. Notebook PDF uses source JSON as Markdown rather than a rendered notebook. |
| Persistence         | Dexie-backed artifacts and versions; boot hydration/migration; per-session active/open artifact tabs.                                                                          | Persistence settings and description drift from the implementation (G2); no account-switch/restart smoke here.                                                                                 |
| Desktop layout      | Browser/Tauri at >=1024px use resizable dock, tabs, narrow/wide modes, focus mode, optional collapsed rail, unread attention and concealed-body retention.                     | Width budgets can use an overlay instead of squeezing the conversation. Actual native panes require an available backend.                                                                      |
| Narrow layout       | Browser <1024px and Capacitor at any width use Sheet/drawer host; phone sidechat is intentionally unavailable.                                                                 | Browser tablet 768–1023px permits sidechat entry points but cannot hand off from an active artifact (F7).                                                                                      |
| Other dock surfaces | Workspace/files, browser/page tabs, cloud documents, sidechat, source control, run context, usage/logs/metadata/memory, Best-of-N, squad/room panels and module contributions. | Their presence is code-backed; this audit does not claim that every remote/native integration was exercised.                                                                                   |

Sources: [`runtime-adapters.ts`](../../components/artifacts/runtime-adapters.ts),
[`agent-tools.ts`](../../lib/artifacts/agent-tools.ts),
[`use-artifact-panel.ts`](../../hooks/artifacts/use-artifact-panel.ts),
[`chat-dock-panels.tsx`](../../components/artifacts/chat-dock-panels.tsx),
[`artifact-workspace-dock.tsx`](../../components/artifacts/artifact-workspace-dock.tsx),
[`session-focus-initializer.tsx`](../../components/providers/initializers/session-focus-initializer.tsx),
[`canvas-bridge-provider.tsx`](../../components/providers/canvas-bridge-provider.tsx),
and ADR-0158.

## Confirmed defect groups

Priorities are repair recommendations from observed reachability and impact.
P1 means a core path or project boundary is broken; P2 means a narrower behavior
fails. They are not claims about measured production incident frequency.

### F1 — P1: fresh/partial settings crash automatic artifact creation

Trigger: a focused assistant turn ends with a qualifying fenced block before
full artifact settings have been saved. Global settings DEFAULTS has no
`artifacts` block; auto-detection defaults to enabled. The real turn-complete
handler passes `minLines: undefined` and `enabledTypes: undefined`, which
overwrite detector defaults during the store's object spread. `shouldAutoCreate`
then throws `Cannot read properties of undefined (reading 'includes')`.
The fire-and-forget Promise has no rejection handler; the surrounding synchronous
try/catch does not catch its rejection. Explicit artifact tools remain usable.

Owning sources: `lib/db/settings.ts:329`,
`hooks/chat/claude-chat-events.ts:231` and `:1931`,
`stores/artifact/artifact-store.ts:1400`,
`lib/ai/generation/artifact-detector.ts:196`.
The direct probe imports actual DEFAULTS and uses the exact event argument shape.

### F2 — P2: automatically detected artifacts lose project ownership

Trigger: create a qualifying artifact in project A through auto-detection, switch
to project B, and open the All artifact list. Auto-creation omits `projectId`,
unlike explicit `createArtifact`. The workspace filter treats it as an unowned
legacy artifact visible across projects. `purgeProject(A)` also leaves it behind.
The probe observed `projectId: null`, `visibleInOtherProject: true`, and
`survivesOriginPurge: true`. This is project list isolation/cleanup failure within
the account; an account authorization bypass was not demonstrated.

Owning sources: `stores/artifact/artifact-store.ts:1445`, `:1005`, `:466`, `:1056`.

### F3 — P2: React preview failure and recovery state are inconsistent

Four related failures were observed:

1. A received `artifact-preview-error` sets the error without ending loading.
2. Fixing JSX after a compilation error renders the corrected component, but
   leaves the old error and runtime-health state. Capture rejects immediately
   with that stale error, so a visually recovered preview cannot export PNG/PDF.
3. Retry increments the iframe key, creating a new frame, while `isFreshFrame`
   ignores the key change and `shellReadyRef` still describes the previous
   frame. React takes the in-place path and never sets the replacement's srcdoc.
4. An initial artifact importing an unbundled package throws inside the blob
   script. The shell has no execution-error listener, so no error is forwarded;
   the host's bootstrap deadline has already cleared. Chromium showed a blank
   preview still loading, with no alert.

Owning sources: `components/artifacts/artifact-preview.tsx:606`, `:615`, `:747`,
`:808`, `:842`, `:1004`; `lib/artifacts/runtime/artifact-shell-entry.ts:91`,
`:125`, `:195`. Three component assertions fail for the expected behavior.
Chromium independently reproduced items 2–4 with the actual component and
committed runtime bundles. Screenshots: `browser-stale-error.png`,
`browser-retry-blank.png`, `browser-runtime-loading.png` in the evidence cache.

### F4 — P2: reveal downloaded file constructs the wrong absolute path

Trigger: save an artifact to `/elsewhere/Page.html` in Tauri and choose Reveal.
`lastDownloadPath` already stores the saver-returned absolute location, but
`handleRevealInExplorer` prepends Downloads again. The actual hook test observed
`/Users/me/Downloads//elsewhere/Page.html` instead of `/elsewhere/Page.html`.
On opener failure the code falls back to opening Downloads, not the chosen file.
The native opener itself was mocked; no Finder invocation occurred.

Owning sources: `hooks/artifacts/use-artifact-panel.ts:325`, `:368`, `:492`;
`lib/files/save-export.ts:117`.

### F5 — P2: background revision proposals raise foreground attention

Trigger: A is focused and the dock is collapsed; B receives an artifact revision
proposal. `pendingReviewCount` counts every session, unlike the scoped active
artifact selector. A global count increase calls `notifyNewArtifact()` and
expands A's dock or mobile Sheet. Explicit dismissal instead causes an unrelated
foreground unread dot. Desktop/mobile expected-behavior assertions both fail.

Owning source: `components/artifacts/artifact-workspace-dock.tsx:243` and `:261`.

### F6 — P2: narrow browser reveal ignores the requesting session

Trigger: a background plugin/agent requests a browser pane for B while A is
focused and no visible pane claims the first request round. The real plugin API
forwards `chatSessionId`; desktop stores the page under B without raising A.
The narrow branch calls `openBrowser(url)` and discards the request context,
opening the Sheet and retaining the URL over A. Mobile/tablet assertions fail.
This establishes a UI routing defect, not an unauthorized read or external send.

Owning sources: `components/artifacts/artifact-workspace-dock.tsx:408`,
`lib/browser/open-url-request.ts:29`, `lib/plugin/api/browser-api.ts:177`.

### F7 — P2: tablet sidechat reveal is stranded behind an active artifact

Trigger: browser width 768–1023px, an active conversation and active artifact,
then `/sidechat` or its shortcut. Those entry points allow tablet widths, but
the dock uses the narrow host. The artifact surface lacks the session-sidechat
panel and its session-surface handoff is guarded with `!mobile`. The reveal
intent remains unconsumed and the artifact stays foreground. Narrow-host tests
reproduce this; slash/shortcut reachability is source-traced. Phones intentionally
reject `/sidechat`, so the product mismatch is the tablet flow.

Owning sources: `components/artifacts/artifact-dock.tsx:417`,
`components/artifacts/artifact-panel.tsx:44`,
`lib/slash-commands/actions/side-chat.ts:39`,
`hooks/chat/use-sidechat-shortcut.ts:33`.

### F8 — P2: standalone math bypasses allowed-type settings

Trigger: leave auto-detection on, disable math, and emit a multiline `$$...$$`
expression. The standalone math branch never calls `shouldAutoCreate`, so
`enabledTypes: ["code"]` still returns a math artifact. Direct detector calls
with `autoCreate: false` also return math, although the chat event has a separate
global auto-create guard. The user-visible claim is the allowed-type bypass.

Owning source: `lib/ai/generation/artifact-detector.ts:252`.

### F9 — P2: inline chart streaming promises a nonexistent artifact

Trigger: stream a qualifying `chart` fence. `detectStreamingArtifact` yields a
pending chart, but sealing the identical fence makes `detectArtifacts` return
none. ADR-0218 intentionally keeps chart fences inline; the streaming detector
does not share that exclusion. The promised pending artifact disappears instead
of becoming a dock artifact; the chart itself still belongs in the transcript.

Owning sources: `lib/ai/generation/artifact-detector.ts:224` and `:298`;
`hooks/artifacts/use-streaming-artifact.ts`.

## Support gaps and intentional limits

- **G1 — Cross-platform acceptance is incomplete.** The shared UI has explicit
  platform branches, but a successful browser render does not establish Tauri
  CSP, native save/reveal, workspace backend, notebook execution or Capacitor
  behavior. This audit carries those limits in X2.
- **G2 — Retention setting lacks a runtime reader.** `persistAcrossSessions` is
  saved by `components/settings/artifacts-section.tsx:186`, but source searches
  locate no persistence/lifecycle consumer. The setting's English hint still
  says localStorage even though artifacts/versions use Dexie. Persistence is
  unconditional and session cleanup follows its own keep rules. A physical
  restart experiment was not performed.
- **G3 — Auto-create toast setting lacks a runtime reader.** `showNotification`
  is passed at `claude-chat-events.ts:1940`, but auto-creation never reads it and
  no artifact toast consumer was located. The setting explicitly promises a
  sonner toast. This is source-backed; a live-provider toast flow was not run.

Intentional limits should remain visible: React cannot import arbitrary npm
packages, scripted HTML needs explicit authorization, plugin-native models use
their own exporters, and notebook PDF currently prints source JSON rather than
the rendered notebook. The last item is a product-quality gap even though the
adapter documents that implementation.

## Reproduction and verification record

Local evidence and throwaway fixtures are under
`.cache/artifact-support-audit/` and are not tracked deliverables. The fixture
scripts are repeatable from the repository root. They do not access live user
accounts or provider data.

```bash
# Actual settings/store/detector counterexamples: F1/F2/F8/F9.
rtk proxy pnpm exec tsx .cache/artifact-support-audit/detection-store-probe.ts

# Expected-behavior counterexamples: 4 suites, 10 failures, 134 skipped.
# These failures reproduce defects; they are not a passing product gate.
rtk proxy pnpm test --config .cache/artifact-support-audit/audit-repro.config.ts --runInBand -t audit --json --outputFile=.cache/artifact-support-audit/all-repros.json

# Actual preview/runtime in isolated Chromium, including capture behavior.
rtk proxy node .cache/artifact-support-audit/browser-probe.mjs
```

Existing baseline checks all passed, without coverage collection:

| Scope                                                             | Suites | Tests | Evidence                       |
| ----------------------------------------------------------------- | ------ | ----- | ------------------------------ |
| Preview, preview-extra, adapters, export index/raster, panel hook | 6      | 107   | `baseline-preview.json`        |
| Panel hook additional cases                                       | 1      | 23    | `baseline-panel-extra.json`    |
| Detector, streaming hook, artifact store                          | 3      | 244   | `detection-store-jest.json`    |
| Workspace dock, artifact dock, layout store                       | 3      | 186   | `dock-baseline.log`            |
| Total                                                             | 13     | 560   | No failed baseline assertions. |

Each baseline used `rtk proxy pnpm test --runInBand --runTestsByPath` with the
corresponding source-adjacent `*.test.ts(x)` files. The cache-only counterexamples
reuse root Jest setup/mappers/transforms and existing integration fixtures; outer
native panes and resize libraries are mocked. The Chromium fixture uses the
actual `ArtifactPreview`, JSX loader/worker and shipped frame bundles, isolating
outer stores, localization, UI wrappers and non-React renderers. It is not a
full Next.js app or a packaged shell.

Repository-wide lint/typecheck/build were not run for this documentation-only
audit. Source-backed support and defects are distinguished from actual UI/device
acceptance throughout. No fixes, commits, pushes or deployments were performed.

## Adversarial review and reconciled inventory

### Contract, method and reconciliation

Follow-up request, 2026-11-08: “做一次对抗性审查，然后给出完整的问题列表”.
The claim under review was that the initial support map and issue list accurately
describe reachable behavior. False positives, missed failures and overstated
environment evidence would all refute that claim.

Three fresh-context reviewers independently inspected creation/data lifecycle,
preview/export, and dock routing. They received source scope and behavior
contracts, not the initial findings or design rationale. The main session then
checked real callers, mount keys, storage transitions and the reproduction
fixtures. This was one bounded review cycle; the substantive issues are recorded
below. The user explicitly selected no additional cross-model review. No external
model CLI was invoked.

Reconciliation changed the earlier report in four material ways:

- The previous Canvas handoff support claim is withdrawn: document creation is
  wired, but the toolbar does not navigate to the actual Canvas shell (B19).
- Automatic artifacts crossing project lists remain a confirmed defect, now P2
  (B05). The evidence establishes project ownership/filtering/cleanup failure,
  not an account authorization bypass.
- The original F3 grouping is split into individual preview failures; classic
  script scope, premature readiness, missing-runtime retry and first-open capture
  failures were added.
- Cross-project access by an explicit artifact ID is observed, but its intended
  authorization semantics are unclear (Q3). It is not counted as a confirmed
  security defect.

“Complete” here means the reconciled list of findings within this audit's stated
scope. Tests with mocked outer services are boundary evidence; they do not become
device or full-app acceptance evidence.

### Confirmed defects

| Issue | Priority | Trigger and observed impact                                                                                                                                                                                                         | Owning source                                                                                                                                    | Evidence and limits                                                                                                                                                                                                                                             |
| ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01   | P1       | Open an HTML/SVG artifact in a new tab: raw content runs in a Blob document with the creating app's origin, outside the preview sandbox and per-artifact interactive grant.                                                         | `hooks/artifacts/use-artifact-panel.ts:408`; `components/artifacts/artifact-panel-content.tsx:300`                                               | Chromium executed the exact Blob/open operation and read/modified harmless same-origin localStorage sentinels. Synthetic local browser origin; no Tauri or reverse-proxy CSP run. IndexedDB access was not separately tested.                                   |
| B02   | P1       | Start automatic creation in account A, activate B while the dynamic import is pending, then allow it to finish: A's content is inserted into B's active artifact store.                                                             | `stores/artifact/artifact-store.ts:1398`; `hooks/chat/claude-chat-events.ts:1932`                                                                | Real-store interleaving probe. No account/storage generation recheck after the await. A live account-switch UI race and B's subsequent durable flush were not exercised.                                                                                        |
| B03   | P1       | Change account scope before the artifact bridge commits a save/create/delete, then quit/reload before reopening the original scope: the latest state exists only in an in-memory retained queue and the old database state returns. | `lib/artifacts/dexie-bridge.ts:80`, `:347`                                                                                                       | Existing-style bridge fixture simulates scope change plus module/process restart. Applies before the 500 ms debounce commits or after a final write failure. Reopening the original account in the same process recovers the retained snapshot.                 |
| B04   | P1       | End a focused assistant turn with qualifying fenced content while artifact settings are absent/partial: explicit undefined fields overwrite defaults and `enabledTypes.includes` throws.                                            | `hooks/chat/claude-chat-events.ts:1932`; `stores/artifact/artifact-store.ts:1400`; `lib/ai/generation/artifact-detector.ts:196`                  | Current real DEFAULTS/store/detector probe reproduced the exception. The fire-and-forget call has no rejection handler. Explicit artifact tools are a separate route.                                                                                           |
| B05   | P2       | Auto-create in project A, switch to B and inspect All: the new artifact lacks projectId, is treated as legacy/global and survives A's project purge.                                                                                | `stores/artifact/artifact-store.ts:1445`, `:466`, `:1056`                                                                                        | Current real-store/filter/purge probe. This is project isolation and cleanup behavior within an account.                                                                                                                                                        |
| B06   | P2       | A scheduled/webhook workflow creates an artifact or Canvas document without a conversation: its deliberate empty session ID falls through to the currently focused conversation.                                                    | `lib/artifacts/workflow-nodes.ts:77`, `:96`; `lib/artifacts/agent-tools.ts:358`                                                                  | Real tool-runner/store probe plus actual workflow caller. Later conversation cleanup can treat that output as owned by the unrelated conversation.                                                                                                              |
| B07   | P2       | Focus another conversation before an ordinary chat turn finishes: heuristic creation and pending targeted-artifact revision routing are skipped, with no replay on refocus.                                                         | `hooks/chat/claude-chat-events.ts:1836`                                                                                                          | Paired actual event-handler probes: focused control called creation; background control made zero calls. Resource-workbench sessions are exempt.                                                                                                                |
| B08   | P2       | Click a file/review link in A, switch to B before the asynchronous session lookup completes: the old callback repopulates global workspace context after the switch cleared it.                                                     | `lib/files/edit-review-bridge.ts:75`, `:122`; `components/artifacts/workspace-mode/dock-workspace.tsx:103`                                       | Deferred-lookup probes reproduced both file and review variants with real routing stores. A's session/root then outranks B in the dock. No unauthorized filesystem operation was demonstrated.                                                                  |
| B09   | P2       | A background agent requests a browser pane in narrow layout: the foreground pane/Sheet receives the URL because target session and, in the fallback branch, backend context are discarded.                                          | `components/artifacts/artifact-workspace-dock.tsx:408`; `components/browser/browser-preview-pane.tsx:685`; `lib/plugin/api/browser-api.ts:177`   | Narrow fallback reproduced with real request routing/stores. The already-mounted first-round listener's missing target-session check is source-backed; no native navigation E2E run.                                                                            |
| B10   | P2       | An artifact or Canvas proposal arrives in a background conversation: the global pending-review count raises the foreground dock/Sheet or its unread signal.                                                                         | `components/artifacts/artifact-workspace-dock.tsx:243`, `:262`; `stores/artifact/artifact-store.ts:1527`, `:1669`                                | Current probe uses actual create/propose actions. UI body is mocked.                                                                                                                                                                                            |
| B11   | P2       | Invoke sidechat at 768–1023px while an artifact is active: entry points allow the request, but the Sheet's artifact surface cannot hand it to the session surface.                                                                  | `components/artifacts/artifact-dock.tsx:417`; `components/artifacts/artifact-panel.tsx:44`; `lib/slash-commands/actions/side-chat.ts:39`         | Production workbench/catalogue probe leaves intent unconsumed; entry-point reachability is source-traced. Phone rejection is intentional.                                                                                                                       |
| B12   | P2       | Update a classic React artifact containing top-level `const App`: a second blob script redeclares the global lexical binding, leaving revision one visible.                                                                         | `lib/artifacts/runtime/artifact-shell-entry.ts:96`; `components/artifacts/artifact-preview.tsx:615`, `:649`                                      | Actual committed runtime/transformer in Chromium: revision two absent; `Identifier 'App' has already been declared`; no preview-error message. Canvas live previews and same-ID revisions reach this path.                                                      |
| B13   | P2       | Blob-script execution or React rendering throws: execution errors are not relayed, and React readiness is announced before successful rendering.                                                                                    | `lib/artifacts/runtime/artifact-shell-entry.ts:210`, `:230`                                                                                      | Runtime Chromium probe emitted ready for a throwing React component, then captured an empty root with no preview error. An initial unsupported import can instead leave loading forever. Error-listener absence and premature readiness are both source-backed. |
| B14   | P2       | A frame sends artifact-preview-error during initial loading: the error is recorded but loading is never cleared.                                                                                                                    | `components/artifacts/artifact-preview.tsx:747`                                                                                                  | Current component observation reproduced error plus loading (`root-loading.json`). This is a separate host-state bug from missing runtime error messages.                                                                                                       |
| B15   | P2       | Press Retry after a scripted frame initialized: the iframe key changes but freshness ignores the key, so code is posted into a replacement frame with no srcdoc/bootstrap.                                                          | `components/artifacts/artifact-preview.tsx:606`, `:615`, `:842`, `:1001`                                                                         | Fresh current-component probe observed a new iframe with empty srcdoc and retained error.                                                                                                                                                                       |
| B16   | P2       | Press Retry after the runtime manifest/load initially failed: loader dependencies do not include the retry key, so initialization is never attempted again.                                                                         | `components/artifacts/artifact-preview.tsx:519`, `:588`; `lib/artifacts/react-runtime-loader.ts:114`                                             | Current-component probe observed one loader call after Retry and the same initialization error.                                                                                                                                                                 |
| B17   | P2       | Correct a React compilation error in place: the corrected component renders, but the old error/errorRef remains, keeping error health and rejecting PNG/PDF capture.                                                                | `components/artifacts/artifact-preview.tsx:617`, `:649`, `:808`, `:394`                                                                          | Fresh current-component probe reproduced retained error; initial real Chromium component probe also reproduced corrected content plus capture rejection.                                                                                                        |
| B18   | P2       | Use first-open React PNG/PDF export, or agent artifact_capture auto-reveal: the workbench's Preview panel still initializes its inner content in Code mode and no preview registry mounts.                                          | `hooks/artifacts/use-artifact-panel.ts:118`; `components/artifacts/artifact-panel-content.tsx:360`, `:596`; `lib/artifacts/capture.ts:73`        | Source-backed integration path. React transcript preview is deferred by default too. Export logs/rethrows without actionable UI; agent auto-reveal can exhaust its five-second mount wait. Manually mounting Preview first can avoid this failure.              |
| B19   | P2       | Click Edit in Canvas: a document is created/selected, but the selected guild stays on chat, so desktop/mobile CanvasShell does not mount.                                                                                           | `hooks/artifacts/use-artifact-panel.ts:223`, `:245`; `components/desktop/desktop-chat-workspace.tsx:713`; `components/app-shell-mobile.tsx:1102` | Real hook/store test created an active Canvas document but observed selectedGuild.kind remain dm. Source traced both toolbar and shell gates; no full-app click run.                                                                                            |
| B20   | P2       | Save to an absolute native path then reveal the download: Downloads is prepended again, yielding an invalid path and a fallback to the wrong directory.                                                                             | `hooks/artifacts/use-artifact-panel.ts:492`; `lib/files/save-export.ts:117`                                                                      | Current actual-hook observation again received `/Users/me/Downloads//elsewhere/Page.html`; fresh reviewer confirmed exposed menu path. Native opener/dialog were mocked.                                                                                        |
| B21   | P2       | Disable math in allowed types while leaving auto-detection on: multiline display math still creates an artifact.                                                                                                                    | `lib/ai/generation/artifact-detector.ts:252`                                                                                                     | Current detector probe with enabledTypes empty returned math. The chat handler separately guards the global auto-create toggle.                                                                                                                                 |
| B22   | P2       | Stream an inline chart fence: a pending dock chart is promised, but sealing the identical fence returns no artifact.                                                                                                                | `lib/ai/generation/artifact-detector.ts:224`, `:298`                                                                                             | Current detector probe shows streaming chart versus empty sealed result. Keeping the final chart inline is intentional under ADR-0218; the streaming promise is inconsistent.                                                                                   |

B01–B04 are prioritized first because they concern application-origin execution,
account boundaries, durable user data, or the default creation path. B05/B08/B09
remain P2 here: the reproduced scope is ownership/UI routing, with no separate
authorization bypass or destructive action established.

### Implementation gaps and unresolved contract

| Gap  | Current behavior and consequence                                                                                                                                                | Source / evidence limit                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DG01 | The Default Preview setting has no consumer; opening always initializes inner viewMode to Code.                                                                                 | `components/settings/artifacts-section.tsx:166`; `hooks/artifacts/use-artifact-panel.ts:118`; source search across app/components/hooks/lib/stores.                                                                                                 |
| DG02 | Persist across sessions has no lifecycle/persistence reader; its hint still describes localStorage although artifact content uses Dexie.                                        | Settings at `:186`; actual bridge and partialize; source-backed, no new physical restart test for the setting itself.                                                                                                                               |
| DG03 | Toast on auto-create is saved/passed but never consumed by auto-creation or an artifact toast handler.                                                                          | Settings at `:156`; event at `claude-chat-events.ts:1940`; source-backed, no live-provider toast run.                                                                                                                                               |
| DG04 | Notebook PDF lays out the notebook's JSON source as Markdown, rather than its cells and rendered outputs.                                                                       | `lib/artifacts/export/pdf.ts:55`; adapter explicitly documents this. Product-quality gap, not a missing raw-download implementation.                                                                                                                |
| DG05 | The live plugin-renderer host reports ready without waiting for handle.ready, so health/loading can precede asynchronous rendering.                                             | `components/artifacts/artifact-renderers.tsx:163`, `:195`; off-screen capture does await readiness. Real office/PDF renderers paint their own errors; no uncaught real-plugin failure was established.                                              |
| DG06 | A consumed historical review destination is not reconstructed after the dock's five-minute cold unmount; reopening returns to the file surface instead of the turn/commit diff. | `artifact-workspace-dock.tsx:375`, `:929`; `workspace-mode/dock-workspace.tsx:197`, `:213`, `:386`. Remount probe reproduced the lost review selection. The five-minute unmount is intentional; preserving the destination is a restoration/UX gap. |

**Q3 — Explicit cross-project IDs:** by-ID artifact read/update/capture/delete
use unscoped access, whereas listing applies project filtering. A real runner
probe read project A's known artifact ID from project B. ADR-0158 specifies
workspace exclusion for Canvas IDs but does not clearly make artifact IDs an
authorization boundary. The behavior is verified; whether an explicit reference
grants cross-project access needs a product/security contract. This is excluded
from the confirmed-defect count.

### Rejected and bounded candidates

- **Cross-artifact draft overwrites another artifact:** rejected for the actual
  dock. `chat-dock-panels.tsx:467–472` keys its preview/editor renderer by session
  and artifact, so the hook-only state-switch reproduction does not represent
  the mounted UI.
- **Out-of-order JSX Worker responses:** not retained. The current worker
  transforms synchronously in FIFO order; a missing generation guard alone does
  not establish a reachable reorder.
- **Plugin mount failure prevents later recovery:** source suggests this
  possibility, but no real bundled-plugin throwing path was demonstrated. It is
  not included among the 22 confirmed defects.
- **Arbitrary npm imports and external HTML scripts:** their restrictions are
  intentional preview capability limits. Their error reporting is covered by
  B13; adding arbitrary package/network execution is not implied as the fix.
- **Mounted-preview export requirement:** intentional API constraint. B18 is
  about visible callers failing to mount or explain that required preview.

### Updated verification record

The initial `.cache/artifact-support-audit/` directory disappeared during the
follow-up, before it was reused; the deleting process is unknown. Its historical
observations remain recorded above. Current probes and refreshed baseline results
are under `.cache/artifact-support-adversarial/`. The audit did not delete that
directory or other sessions' files.

| Current check                                                | Actual result                                                                                                        | Evidence                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Same 13 source-adjacent baseline suites as the initial audit | 560 tests passed, 13 suites passed, 13.545 s                                                                         | `root-baseline.json`, `root-baseline.log`                                                   |
| Data/store/runner/bridge counterexamples                     | Six expected-contract assertions failed; one is Q3 and is not promoted to a confirmed security defect                | `data-probe-results.log`; `data-store.test.ts`, `data-agent.test.ts`, `data-bridge.test.ts` |
| Real turn-completion handler focused/background pair         | Focused control passed; background expected-creation assertion failed                                                | `data-events-results.log`, `data-events.test.ts`                                            |
| Dock routing counterexamples                                 | Five expected-contract assertions failed across attention, browser target, sidechat, file/review race                | `dock-probe-results.log`                                                                    |
| Dock cold-remount observation                                | Expected retained review-destination assertion failed; classified DG06                                               | `dock-remount-results.log`                                                                  |
| Canvas toolbar handoff                                       | Expected canvas guild assertion failed; active document existed                                                      | `root-panel.json`, `root-panel.log`                                                         |
| Current preview component observations                       | Three probes passed by asserting the observed bad states for B15/B16/B17                                             | `preview-state-probes.log`, `preview-state.test.tsx`                                        |
| Additional current host-error and native-path observations   | Both passed by asserting retained loading and the duplicated absolute-path prefix                                    | `root-loading.json`; passing observation in `root-panel.json`                               |
| Actual shipped frame runtime and transformer in Chromium     | Observed classic binding redeclaration, premature ready/empty-root capture, and host-origin Blob localStorage access | `preview-runtime-probes.log`, `preview-runtime-probes.mjs`                                  |
| Refreshed DEFAULTS/store/detector observations               | Reproduced B04/B05/B21/B22                                                                                           | `root-detection.log`, `root-detection.probe.ts`                                             |

There were 14 failing expected-contract assertions in this follow-up. That count
includes one unresolved-contract assertion (Q3) and one restoration-gap assertion
(DG06); it is not the number of confirmed bugs. The three passing preview probes
assert existing failures and are not evidence of fixed behavior. No coverage,
full typecheck/build, packaged Tauri/device run, or real-provider flow was run.

Representative rerun commands (from repository root):

```bash
rtk proxy pnpm exec tsx .cache/artifact-support-adversarial/root-detection.probe.ts
rtk proxy node .cache/artifact-support-adversarial/preview-runtime-probes.mjs
rtk proxy pnpm test --config .cache/artifact-support-adversarial/root-panel.config.ts --runInBand
rtk proxy pnpm test --config .cache/artifact-support-adversarial/preview-probe.jest.config.ts --runInBand
```

For the other source-adjacent baseline and cache-only counterexamples, their
retained result logs include the exact runner arguments. Cached fixture files
are local investigative artifacts, not product changes or a committed regression
suite. Each repaired defect should acquire a focused, source-adjacent regression.

## 2026-11-18 复核与行业对照

复核基于 `8991a9d7be` 及当前共享工作树。范围从聊天里的产物卡片进入右侧 Dock，覆盖预览、编辑、审阅、历史、Canvas、导出和窄屏入口。会话文件、浏览器页签和 Side Chat 仅检查与产物切换直接相关的交互。对有独立工作流的 Sites 和文档转换，沿用各自的证据报告。产品对照来自官方文档。分析范围不涉及上线、公开分享或真实账户操作。

### 当前支持

| 用户路径   | 当前实现                                                                                                                                                                            | 证据边界                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生成和找回 | Agent 工具、围栏检测、聊天代码块手动创建、插件和工作流入口。聊天内联卡片可回到 Dock，桌面有按会话记忆的页签和新页签的近期产物。产物页签能定位源消息并引用到聊天。                   | [Agent 工具](../../lib/artifacts/agent-tools.ts)、[聊天产物卡片](../../components/chat/message-parts/artifact-part.tsx#L102)、[新页签](../../components/artifacts/dock-new-tab-page.tsx#L195)、[Dock 页签](../../components/artifacts/dock-tab-strip.tsx#L626)                                       |
| 查看和运行 | Code、Markdown 文档、HTML、React、SVG、Mermaid、图表、公式、Jupyter 有内建适配器。支持类型可在 Code、Preview、Split 间切换。React 走本地沙箱运行时，HTML 交互默认关闭并按产物授权。 | [运行时适配器](../../components/artifacts/runtime-adapters.ts)、[预览框架](../../components/artifacts/artifact-preview.tsx)、[产物面板](../../components/artifacts/artifact-panel-content.tsx#L218)                                                                                                  |
| 编辑和验证 | 原位源码编辑、版本比较与恢复、AI 修改逐项审阅、评论、选区或页面元素引用、Canvas 副本入口。会话层可并列打开文件、浏览器页、云文档、Side Chat 和任务工具。                            | [面板代码](../../components/artifacts/artifact-panel-content.tsx)、[审阅](../../components/artifacts/artifact-review-view.tsx)、[版本](../../components/artifacts/panel-version-history.tsx)、[Dock 架构](../content/docs/en/adr/0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task.md) |
| 交付和跨端 | 按类型下载源码及导出 PNG/PDF 等，桌面可保存进工作区。窄屏用 Sheet，手机编辑走轻量编辑器。Dexie 保存产物及已保存版本。                                                               | [格式入口](../../hooks/artifacts/use-artifact-panel.ts#L383)、[保存进项目](../../hooks/artifacts/use-artifact-panel.ts#L490)、[窄屏容器](../../components/artifacts/artifact-workspace-dock.tsx#L492)、[持久化](../../lib/artifacts/dexie-bridge.ts)                                                 |

### 旧结论更新

此前 22 个问题和 6 个实现缺口均能在当前 HEAD 的提交史里找到对应处理，覆盖关系见下表。这里只认定修复代码已落地。581 个相关现有断言提供本轮局部回归证据，应用层或设备层的端到端结果仍需对应环境。

| 2026-11-08 条目                    | 当前提交证据                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| B01、B18–B20、DG01、DG04、DG05     | `7847faa742`，新标签预览隔离、导出准备、Canvas 导航、默认视图消费、Notebook PDF 及插件加载。捕获就绪和新标签 bootstrap 有 `7b7abc3671` 的后续。 |
| B02、B04、B05、B07、B21、B22、DG03 | `8cb69fd501`，自动创建的账户、项目与会话归属，设置合并、类型规则、流式一致性和 toast。                                                          |
| B03、B06                           | `e147f2c947`，换账户前冲刷写入及工作流归属。超时处理有 `b2aa1ccee1` 的后续。                                                                    |
| B08–B11、DG06                      | `741dfaf962`，异步路由、按会话通知、窄屏交接和审阅目标恢复。另有 `8794ee6f19` 调整失效判断及运行时清理。                                        |
| B12–B17                            | `97459e8e0e`，预览修订、错误和 Retry。React 执行及捕获语义随后由 `7b7abc3671`、`399c9095fa` 调整。                                              |
| DG02、Q3                           | `32e98f9b30` 移除无效保留开关。`9f08323000` 增加项目范围内按 ID 访问。                                                                          |

### 本轮发现

| ID  | 优先级          | 当前表现                                                                                                                                                                                  | 证据                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | **P1**          | 编辑 A，输入未保存内容，点击 B，再回 A 重新进入编辑，内容退回上次保存版本。Dock 记住了产物标签，编辑缓存随面板实例销毁。                                                                  | 组件组合复现。使用真实页签、面板、Hook 和 Store，按实际会话与产物 key 挂载，仅将 Monaco 简化为输入控件。探针确认编辑时保存按钮启用，返回后旧文本恢复且保存按钮禁用。[面板 key](../../components/artifacts/chat-dock-panels.tsx#L466)、[本地编辑缓冲](../../hooks/artifacts/use-artifact-panel.ts#L151)、[进入编辑](../../hooks/artifacts/use-artifact-panel.ts#L306)                   |
| A02 | **P2**          | 在空的版本历史里点击「保存版本」，Store 已新增快照，面板仍显示空。等外部重渲染或重新打开才看得到。                                                                                        | 真实版本面板与 Store 复现。面板订阅 getter 和 actions，未订阅版本列表。Chrome 中点保存仍见空态，切换 Code 触发重渲染后出现 Restore。已有测试断言存储成功，漏掉可见历史更新。[面板订阅](../../components/artifacts/panel-version-history.tsx#L98)、[快照写入](../../stores/artifact/artifact-store.ts#L1769)、[已有断言](../../components/artifacts/panel-version-history.test.tsx#L51) |
| A03 | **P2**          | 在桌面页签上按 Delete，邻居 tab 被激活，键盘焦点落到页面 body。接着按方向键无法沿页签继续操作。                                                                                           | 真实 DockTabStrip 和 DOM 焦点复现。外层 tab 也没有同一组 `aria-controls`/面板关联，后者是源码发现，未做读屏验证。[关闭和键盘处理](../../components/artifacts/dock-tab-strip.tsx#L378)、[外层 tab 语义](../../components/artifacts/dock-tab-strip.tsx#L537)、[WAI-ARIA Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)                                                            |
| A04 | **P2**          | 聊天产物卡片提示「在画布中打开」或「Open in canvas」，实际打开右侧 Dock。Dock 的「Edit in Canvas」打开另一套编辑器。同一文案概念对应两个目的地。                                          | 可达入口和英文文案源码交叉确认。[卡片动作](../../components/chat/message-parts/artifact-part.tsx#L322)、[卡片露出 Dock](../../components/chat/message-parts/artifact-part.tsx#L129)、[中文文案](../../i18n/messages/zh-CN/chat.json#L65) · [英文文案](../../i18n/messages/en/chat.json#L65)、[真正的 Canvas 导航](../../lib/artifacts/reveal.ts#L71)                                   |
| A05 | **P2 交互缺口** | 产物首次转到 Canvas 后建立关联。后来产物改成 v2，再点「Edit in Canvas」仍打开原有 Canvas 文档及其副本内容。保留 Canvas 手改是合理的，界面需要揭示正在编辑的对象、来源版本和两端已经分叉。 | 真 Hook / Store 复现，Canvas 标识不变、内容仍为初版，产物已经更新。应给出打开已有副本或明确采用当前产物版本的选择，需要裁决冲突语义。[复用逻辑](../../hooks/artifacts/use-artifact-panel.ts#L259)、[关联写入](../../stores/artifact/artifact-store.ts#L1905)                                                                                                                           |
| A06 | **P2 交互缺口** | 默认 Code 已接线且可切换。来自 HTML/图表等可视产物的预览意图与已有视图偏好没有独立入口。导出、历史和部分管理动作共用 More，适合放高级项，交付格式和用途却缺少一眼能懂的入口。             | 展示和动作分类来自源码推断。是否拖慢任务仍需用户路径计时。[视图初始化](../../hooks/artifacts/use-artifact-panel.ts#L119)、[更多与导出](../../components/artifacts/artifact-panel-content.tsx#L332)                                                                                                                                                                                     |
| A07 | **P2 交付缺口** | Word 按「是否由插件拥有」开放，核心实现直接把产物内容当 Markdown。图表配置和 notebook JSON 可得到 Word 文件，其内容仍是源数据文本。代码 PDF 也走同一文本解析路径。                        | 本轮检查了菜单条件与实际导出分发。代码 PDF 保真问题已有同日独立探针，见文档审计。没有把插件原生导出或已修复的 Notebook PDF 合并成同一个问题。[Word 条件和 writer 调用](../../hooks/artifacts/use-artifact-panel.ts#L383)、[PDF 分发](../../lib/artifacts/export/pdf.ts#L91)、[文档审计](./2026-11-18-document-parsing-export-gap-audit.md)                                             |
| A08 | **P2**          | 在 Dock 里点产物工具栏内的 Close 图标，当前产物和 Dock 都留在原位。Dock 顶部的关闭是另一入口。                                                                                            | 实际桌面 Dock Storybook 中用 Chrome 点击，产物标题和 Close 均继续可见。工具栏只写旧的 `panelOpen`，Dock 由独立的布局状态和激活资源驱动。[工具栏 Close](../../components/artifacts/artifact-panel-content.tsx#L287)、[旧关闭状态](../../stores/artifact/artifact-store.ts#L2415)、[Dock 容器](../../components/artifacts/artifact-dock.tsx#L503)                                        |

### 官方实践对照

| 参照                | 对照后值得采用的交互                                                                                                                                                                                                                                                                                                                                     | Cognia 的落点                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Artifacts    | 产物有独立身份，能从该对象继续编辑、按类型导出、授权分享。文档针对选区发起编辑，移动端可访问产物，部分分享管理交给桌面。资料区分当前 Artifacts 和旧版。 [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) · [Share artifacts](https://support.claude.com/en/articles/9547008-share-artifacts) | 已有来源、资源侧聊、选区和逐项审阅。优先让卡片、Dock、Canvas 正确表明当前对象与版本。以后接发布可利用独立 Sites 的交付能力，网页产物需要明确版本与访问控制。 |
| ChatGPT Canvas      | 官方发布说明展示原位编辑、选中范围中的行内反馈以及回到早期版本。 [Introducing canvas](https://openai.com/index/introducing-canvas/)                                                                                                                                                                                                                      | 已有逐项接受和版本 diff。应把手动草稿、AI 提案和已保存版本状态连起来。选区指令保留当前对象和基准版本。                                                       |
| Gemini Canvas       | 代码可直接编辑并自动保存，应用预览旁提供 console 和最近变更。文档有历史版本，交付能衔接 Docs、Slides、Colab。 [Gemini Canvas](https://support.google.com/gemini/answer/16047321?co=GENIE.Platform%3DDesktop&hl=en)                                                                                                                                       | 对 HTML/React 提供本次运行的可复制错误上下文。交付菜单按可编辑文档、源码和视觉快照区分。源文本和视觉结果会给出不同格式。                                     |
| VS Code 与 WAI-ARIA | Hot Exit 能恢复内容未保存的缓冲，文件变化可产生保存冲突提示。WAI-ARIA Tabs 约定关闭后将焦点交给相邻页签或合适的后续控件。 [VS Code Basic editing](https://code.visualstudio.com/docs/editing/codebasics) · [Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)                                                                                | 在现有按会话恢复页签的基础上，补草稿恢复、修改标记和明确丢弃。底层产物发生变化时提示冲突。给页签补焦点交接和面板关联。                                       |

### 建议排序与验收

1. **保住编辑内容和版本。** 切换产物、会话、折叠 Dock 或切换布局后能续写。未保存草稿单独保存或显式提示。AI 提案、版本恢复和其他写入可与草稿并存，提交时检查基准版本。点「保存版本」后立即出现可比较和恢复的条目。先用组件回归覆盖这些确定性条件，再加一条主应用 E2E 覆盖真实挂载与会话轮转。
2. **把预览、编辑、交付的目的地说清楚。** 卡片使用「在右侧打开」。标明「打开关联 Canvas」和「从当前版本创建 Canvas 副本」。给可读产物保留一个直接进入预览的入口，代码保留源码和拆分选择。让工具栏关闭、关闭页签和收起 Dock 各自有清晰作用。桌面与 Sheet 均能访问核心动作。在同一个 E2E 固定源版本、转 Canvas、改源及返回路径的验收状态。
3. **按产物类型收拢交付，再处理诊断和发布。** 文档交付可编辑格式，代码交付文本，图表和应用提供视觉快照，插件继续声明自己的格式。给 HTML/React 输出明确的运行状态和调试入口。公开分享需要另订版本固定、访问范围和撤回合同。

### 本轮验证记录

- 现有 Jest 测试 11 个套件、581 个断言通过。范围包括 Dock、历史、预览、编辑 Hook、Store、Dexie、自动检测和导出。
- `pnpm test --config .cache/right-artifact-audit/jest.config.ts --runInBand --silent` 运行 4 个隔离观察探针，全部命中预期观察。编辑器输入使用简单模拟，真实部件和 Store 仍走生产实现。
- 使用 Chrome 147.0.7727.56，通过独立 Storybook fixtures 检查桌面 Dock 和 HTML 预览。局部 Close 保持原产物显示，保存的版本直到切换到 Code 后才出现在历史中。命令为 `node .cache/right-artifact-audit/storybook.probe.mjs`。截图在 `.cache/right-artifact-audit/storybook-{dock,history-after-save}.png`。Dock story 的聊天内容是占位，种子没有设置已打开标签。页签切换与焦点以隔离组件探针为证据。
- 完整应用的 `pnpm test:e2e --project=chromium tests/e2e/web/dock-tabs.spec.ts tests/e2e/web/dock-narrow-window.spec.ts --workers=1` 发现 7 个用例。开发服务器在 `predev` 的插件产物阶段退出 1，错误为 `Plugin artifact contract: Host authoring kit ABI; regenerate and validate the kit before updating its pin mismatch`。实际执行 0 个用例。现有两个 Web specs 覆盖 Dock 标签、会话记忆、宽度与 overlay，缺少带真实产物的编辑、历史和 Canvas 路径。
- 本轮交付为证据与优先级分析。真实 Tauri、Capacitor、Provider 与文件导出验收仍开放。

## 2026-11-18 对抗性复审

基于 `d425a059a7` 和当轮共享工作树。收尾时 HEAD 前进至 `6948032cfb`，两次提交属于 CLI 与 Sites，已比对本次主要核查路径。三个独立审查分别从编辑与版本、Dock 路由、预览与交付出发，只取得源码范围和用户路径合同。主审复核生产调用链，用同一路径的成功对照排除测试夹具造成的假象。此前的行业对照提供体验参考，本轮的缺陷判定以现有交互合同、源码和可重复观察为准。

### A01–A08 逐项裁定

| 条目                       | 裁定                              | 证据与影响上限                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 未保存草稿丢失         | **确认，P1**                      | 实际 `ArtifactWorkspaceDock`、真实页签和 Store 驱动 A→B→A。未保存文本消失，先点 Save 的同流程保留已提交文本。Monaco 输入用轻量控件代替。普通标签切换足以触发。相同资源内保留的面板、短时收起和持久数据分别有不同生命周期，不能归纳成一切离开都会丢。 [面板重建边界](../../components/artifacts/chat-dock-panels.tsx#L466) · [编辑状态](../../hooks/artifacts/use-artifact-panel.ts#L151)                                                                         |
| A02 版本保存后历史不刷新   | **确认，P2**                      | Chrome 点击 Save Version 仍显示空态，切换 Code 后出现 Restore。Store 探针确认点击即新增一条快照。影响是即时反馈和操作可见性，现有证据显示快照仍在。 [历史订阅](../../components/artifacts/panel-version-history.tsx#L98) · [保存快照](../../stores/artifact/artifact-store.ts#L1769)                                                                                                                                                                             |
| A03 键盘关页签后失焦       | **确认，P2**                      | 同会话 Desktop Delete 选中正确邻居但焦点落到 body。独立测试还看到方向键由会话 tab 切到产物时焦点留在旧的 hidden/inert tab，窄屏 Close 和 Drawer 出口也有 DOM 焦点恢复缺口。外层 tab–tabpanel 语义关联为源码观察。影响限键盘导航，尚无真机读屏结论。 [页签键盘处理](../../components/artifacts/dock-tab-strip.tsx#L378) · [主机切换](../../components/artifacts/artifact-dock.tsx#L106) · [WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| A04 “在画布中打开”         | **确认文案误导，降 P3**           | 实际卡片打开 Dock，并保持原来的 Canvas 文档不动。真实 Canvas 入口仍能切到 Canvas guild。影响限于入口预期，打开产物本身成功。 [卡片动作](../../components/chat/message-parts/artifact-part.tsx#L129) · [Canvas 路由](../../lib/artifacts/reveal.ts#L71)                                                                                                                                                                                                           |
| A05 Canvas 复用旧副本      | **保留为交互取舍，移出功能缺陷**  | 同项目内再次交接始终打开已有 Canvas，保留 Canvas 本地编辑。源产物更新也不会隐式覆盖副本。可展示来源版本和分叉，但复用本身有明确价值。另确认恢复产物版本能误断关联，见 C04。 [复用逻辑](../../hooks/artifacts/use-artifact-panel.ts#L259)                                                                                                                                                                                                                         |
| A06 默认 Code、操作在 More | **撤回原 P2，保留待量化体验假设** | Chrome 验证默认 Code，点 Preview 后正确渲染 HTML。设置有消费者，聊天卡片也有预览入口。没有证据支持默认 Code 或菜单位置构成普遍阻塞。 [默认设置读取](../../hooks/artifacts/use-artifact-panel.ts#L119) · [内联预览](../../components/chat/message-parts/artifact-part.tsx#L192)                                                                                                                                                                                   |
| A07 Word/PDF 保真          | **确认，P2，按格式和类型限定**    | 用实际生成器检查字节。图表 DOCX 的内容 XML 为 JSON 文本，代码 PDF 丢失 Python 注释前缀并合并缩进代码行。有效 Notebook 的 PDF 正确呈现示例输入与输出，SVG PNG 也通过像素对照。插件原生导出、所有类型或原生保存结果不在反例范围内。 [Word 分发](../../hooks/artifacts/use-artifact-panel.ts#L430) · [PDF 分发](../../lib/artifacts/export/pdf.ts#L91) · [文本解析](../../lib/files/document-writer/blocks.ts#L45)                                                  |
| A08 产物工具栏 Close       | **确认，P2**                      | Chrome 在桌面 Dock 和 420px Web Sheet 均见内层 Close 后内容仍在。实际外层 Close 有效，桌面在 Chrome 验证，窄屏在独立 DOM 探针验证。根因是内层只写旧的 `panelOpen`，两套容器均取独立布局状态。 [内层 Close](../../components/artifacts/artifact-panel-content.tsx#L287) · [旧状态](../../stores/artifact/artifact-store.ts#L2415) · [Sheet 状态](../../components/artifacts/artifact-panel.tsx#L17)                                                               |

### 遗漏项与新增反例

| ID  | 优先级           | 复现或约束                                                                                                                                                                                                                                                          | 证据边界                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | **P1**           | **审阅结果与接受的 diff 不一致。** 原文 `a / b / c / d`，提案 `A1 / A2 / b / x / c / d`。逐项接受再 Apply 得到 `A1 / A2 / b / c / x / d`。单个空行插入也会被吞，空文档接受首段内容可多出换行。仅等长的前置替换加插入则正确。                                        | 用真实 ArtifactReviewView 按钮、Store 和 diff 验证。新侧行号被应用到旧侧，空字符串被解释成无替换行。旧内容仍有快照。Canvas 使用同一合并函数，是源码确认的共同影响面，Canvas 壳 E2E 未跑。 [计算与应用](../../lib/ai/generation/canvas-review.ts#L68) · [产物保存](../../stores/artifact/artifact-store.ts#L1606) · [Canvas 保存](../../stores/artifact/artifact-store.ts#L1741)   |
| C02 | **P2**           | **并行提交与后台预览打断手动编辑。** 编辑 v1 时别的写入提交 v2，随后手动 Save 会以 v1 草稿替换 v2，中间无冲突提示。针对正在编辑的同一产物发出 Preview 请求也能退出编辑，重新点 Edit 会加载旧内容。                                                                  | UI + Store 复现覆盖两条路径，v2 可从历史快照恢复。Agent capture 仅在缺少对应预览时走 reveal 与 Preview 请求。没有把所有捕获或所有切换判成草稿丢失。 [手动保存](../../hooks/artifacts/use-artifact-panel.ts#L314) · [预览事件](../../hooks/artifacts/use-artifact-panel.ts#L158) · [捕获调用](../../lib/artifacts/capture.ts#L80)                                                  |
| C03 | **P2**           | **在其他会话复用产物后，关闭改错会话。** A 和 B 已各自打开由 A 产生的产物，在 B 点该 tab 的 X，实际移除 A 的 tab，B 的 tab 留着。若 A 没有该 tab，关闭无效。                                                                                                        | 真 tab strip 与 Store 复现。Recent 可抵达同项目的跨会话路径。只影响页签和选中状态，未见删除内容或跨账户访问。同一会话关闭为成功对照。窄屏重排也按来源会话找 tab，当前归源码发现。 [Recent](../../hooks/artifacts/use-artifact-list.ts#L76) · [打开](../../lib/artifacts/reveal.ts#L8) · [关闭与重排](../../stores/artifact/artifact-store.ts#L1198)                               |
| C04 | **P2**           | **恢复历史版本会断掉 Canvas 复用。** 先为产物存版本，再送到 Canvas D1 并编辑 D1，恢复交接前的产物版本，再点 Edit in Canvas，会新建 D2。                                                                                                                             | Hook、Store 和实际 Canvas 路由状态复现。D1 及其编辑仍在，用户被带到错误副本。版本恢复用旧快照的整段 metadata 覆盖了 D1 引用。另一个受限反例是旧产物在另一项目可见且仍指向原项目的 Canvas，此时项目检查正确拒绝导航，但面板没有反馈。 [恢复版本](../../stores/artifact/artifact-store.ts#L1829) · [再次交接](../../hooks/artifacts/use-artifact-panel.ts#L269)                     |
| C05 | **P2**           | **窄屏开关状态分裂。** 已恢复桌面 open、但 Sheet 尚未打开时，窄屏按钮显示已开启，第一次点击仍关闭，第二次才打开。平板 Ctrl+J 只打开旧旗标，Sheet 留在关闭。由桌面主动打开后缩到窄屏会进入已预置为打开的 Sheet。                                                     | 用实际 Toggle、快捷键分发与真实断点分支，控制断点的 DOM 复现。最后一种表现有可讨论的响应式取舍，和前两种可达性缺陷分开。 [恢复状态](../../stores/artifact/artifact-dock-layout-store.ts#L433) · [窄屏快捷键](../../hooks/artifacts/use-artifact-dock-shortcuts.ts#L22)                                                                                                            |
| C06 | **P2**           | **页签与当前资源分离。** 已关闭的产物收到审阅提案后，Dock 显示该产物的审阅界面，却没有对应活动标签。另一个已保存的 Project overview tab 在条件失效后可选中空白面板，New Tab 经过窄屏工作台重算也可能被替换为 Artifacts。                                            | 前者用实际 Workspace Dock 与 Store 复现。后两项用真实 Workbench/tab 组件和受控面板可用性、断点复现。影响取决于 tab 是否已保存和条件是否变化。 [提案激活](../../stores/artifact/artifact-store.ts#L1544) · [页签目录](../../components/artifacts/dock-tab-strip.tsx#L309) · [面板可用性](../../components/context-workbench/context-workbench.tsx#L977)                            |
| C07 | **P2**           | **PNG/PDF 可与看到的预览不同。** 授权交互 HTML 的 iframe 执行后从红变绿，PNG 仍为静态红色。React 在对应的实际 iframe 里有蓝色按钮和普通色块，快照进入 PNG 前被静态清理，按钮消失，普通色块保留。滚动渲染器试件的 PNG 只包含可视区域，同一高度的内容随滚动位置变化。 | 使用出货沙箱运行时、实际栅格导出器与 Chrome 像素校验。滚动使用模拟已注册的容器，未盘点每种真实 renderer 的长内容。静态 SVG 和普通元素有通过对照。 [栅格分发](../../lib/artifacts/export/raster.ts#L171) · [快照清理](../../lib/artifacts/preview-utils.ts#L149)                                                                                                                   |
| C08 | **P2，部分验证** | **同 ID 的预览没有版本或宿主绑定。** 对旧内容发起的图表导出请求，在同 ID DOM 改变后读到新像素。内联卡片和 Dock 都可注册同 ID，最后注册者覆盖旧值，销毁最后注册者也不会恢复此前的注册。                                                                              | Chrome 证实渲染器边界的版本反例。双宿主生命周期由源码确认，未测量完整产品里各自注册先后和错误频率。 [DOM 注册](../../lib/artifacts/preview-registry.ts#L22) · [iframe 注册](../../lib/artifacts/frame-capture-registry.ts#L53) · [卡片挂载](../../components/chat/message-parts/artifact-part.tsx#L204) · [Dock 挂载](../../components/artifacts/artifact-panel-content.tsx#L579) |
| C09 | **P2**           | **核心 PDF 的非拉丁文本保真。** 中文文档试件生成 PDF 后，PDF.js 提取标题与正文均为乱码。坏 Notebook JSON 的 PDF 分支还会成功返回源文本，未报告无法按单元格输出。                                                                                                    | 实际 PDF 字节与 PDF.js 对照。首项结论覆盖抽取/搜索与字体实现，未遍历所有平台查看器。有效英文 Notebook 作为通过对照。 [PDF 路由与字体](../../lib/artifacts/export/pdf.ts#L51) · [核心 PDF writer](../../lib/files/document-writer/index.ts#L60)                                                                                                                                    |
| C10 | **P3**           | **Re-diff 在提案内容已等于当前内容时仍显示过期。** 点击 Re-diff 无变化，Discard 可退出。若当前修改与原提案不同，Re-diff 用当前内容到旧提案做完整 diff，可能显示撤销无关人工修改的 hunks。                                                                           | 真实审阅 UI / Store 确认相同文本的空操作和 Discard 成功。另一个行为可在审阅中看到，归为合并语义与提示缺口。 [Re-diff 动作](../../components/artifacts/artifact-review-view.tsx#L126) · [相同内容早退](../../stores/artifact/artifact-store.ts#L1544)                                                                                                                              |

### 降级或保留待证实项

- **撤回跨产物显示上一份下载路径的候选。** 常规 A→B 通过生产 key 重挂载，旧 Hook 的异步完成不会写入 B 的新实例。同一产物在新版本仍提供最近一次下载的位置，符合最近下载的现有语义。 [渲染 key](../../components/artifacts/chat-dock-panels.tsx#L466)
- **保留生命周期候选。** 独立作者探针确认第二个提案直接替换 `pendingReviews[id]` 和已选 hunks。是否允许同时保留多个候选属产品合同，界面应揭示发生替换。发出定向编辑时存的是目标 ID 和请求 ID，完成时用当下内容重新生成审阅，有人工修改夹在中间时可能提议撤销它，仍待带模型延迟的完整流程验证。图表 Preview 的容器注册早于内部渲染就绪，可能捕获 Skeleton 或诊断。普通导出的通用错误文案建议打开预览，代码产物没有预览 tab；工作区路径前缀检查和移动端同名导出的影响需对应平台验证。 [提案 Store](../../stores/artifact/artifact-store.ts#L1544) · [发起时上下文](../../components/chat/composer/composer-turn-handlers.ts#L680) · [完成时路由](../../hooks/chat/agent-chat-events.ts#L1860) · [预览节点](../../components/artifacts/artifact-preview.tsx#L991) · [工作区保存路径](../../hooks/artifacts/use-artifact-panel.ts#L506) · [移动保存](../../lib/files/save-export.ts#L111)
- **记录 ADR 口径漂移。** 当前窄窗宽度预算保留会话侧栏偏好并更早浮起 Dock，早期 ADR 写的是先临时收起侧栏。属于现实现实与文档需要对齐，缺少把保留偏好判为产品错误的依据。 [宽度预算](../../hooks/shell/use-chat-row-budget.ts#L69) · [ADR-0214](../content/docs/en/adr/0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task.md#narrow-windows)

### 修复顺序与验收

1. **先保住内容正确性。** 接受全部 hunks 时必须得到逐字符等同提案的结果，选择部分时按原文锚点应用。专测前置增删、空行和不相邻 hunks。切回现有产物要恢复草稿，基准内容已变化要显式处理，保存的快照立刻可见。
2. **让导航只改当前对象。** 在 B 关闭 A 来源的 tab 只移动 B 的导航状态。关闭后焦点落在可见相邻 tab 或开启按钮。历史恢复后仍能重开已编辑的正确 Canvas 副本。按桌面、平板、手机分支分别校验关闭与快捷键。
3. **让交付与菜单承诺一致。** 明确源码和视觉快照的入口，校验选中版本、实际预览实例和导出字节。加入中文 PDF、结构化图表、有效和无效 Notebook、互动预览、长内容截断的样例。

### 可复核的运行证据

- 主审的 `pnpm test --config .cache/right-artifact-adversarial/jest.config.ts --runInBand --silent` 运行 10 个实际组件/Store 观察与对照，全部完成。包括真实挂载 Dock 切换、三种 hunk 应用、版本恢复后 Canvas 身份、预览中断和已关闭产物提案。
- 现有 12 个 Jest 套件的 488 个测试通过，包含生产 diff、Review、Dock、历史、编辑、Store 与导出基线。独立作者与 Dock 探针及日志在 `.cache/right-artifact-adversarial-authoring/` 和 `.cache/right-artifact-adversarial-dock/`。独立作者组末次为 13 个观察和对照，Dock 组为 12 个。其中部分场景与主审探针重合。
- Chrome 147.0.7727.56 的两组证据为 Storybook 实际组件交互和浏览器运行时的交付字节。见 `.cache/right-artifact-adversarial/chrome.log` 与 `.cache/right-artifact-adversarial-delivery/`。导出探针替代了文件保存边界，记录渲染后的字节和像素。
- 再跑完整浏览器套件仍在 `predev` 的同一插件 authoring-kit ABI 检查退出 1。已有 Chromium specs 实际执行 0 个。真实账户、Provider、Tauri、Capacitor 和外部读屏器仍未验收。
