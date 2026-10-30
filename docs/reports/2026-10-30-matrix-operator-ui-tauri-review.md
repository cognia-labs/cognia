# Matrix operator UI and real Tauri IPC review — 2026-10-30

## Delivered behavior

The existing Matrix connector edit dialog now mounts a desktop-only verification
panel against the running adapter. It supports incoming requests, decimal SAS
comparison and explicit match/refusal, SDK-rendered binary QR display, image
upload and camera decoding, explicit scan acknowledgement, cancellation, and
retry of the original failed action. Device-key download after asynchronous
proof completion is an explicit **Refresh device trust** operation; it cannot
confirm a SAS or QR proof.

The new panel is separate from the configuration form because an active
verification owns transient protocol state, camera tracks and QR secrets that
must be disposed with the panel. The existing MatrixVerification owner still
owns delivery serialization and transaction retries. The QR decoder is a
separate browser utility so both file and camera paths preserve `jsQR.binaryData`
and can share validation without treating the Matrix binary payload as text.

The opt-in `connector-tauri-fixture` binary is a real Wry system webview. Stdio
only schedules JavaScript; JavaScript invokes the registered production Tauri
command wrappers, and a separate test-only result command returns the result.
There is no direct Rust command-dispatch fallback in this lane. It uses a
private encrypted secret store, private Matrix SQLite stores and an incognito
webview. Each process receipt validates and retains its Wry/invoke/child-PID
identity. A separate test binary is necessary because the normal app's startup
opens the operator's profile and initializes unrelated services.

## Adversarial review and reconciliation

The UI received three independent read-only review cycles. IPC/harness received three.
The existing user preference to skip external-model review was retained.

| ID          | Finding                                                                                 | Correction and regression                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-01 / P1  | Incoming requests could be accepted by a replacement adapter.                           | Bind discovery results to the API owner; reject mismatched acceptance before dispatch. Deferred-owner unit regression.                                                                             |
| UI-02 / P2  | A late camera grant could reopen tracks after cancellation.                             | Invalidate camera generations on actions, terminal states and disposal; reject late grants. Cancellation-before-grant regression.                                                                  |
| UI-03 / P2  | Concurrent camera permission requests could leak a stream.                              | Single-flight permission guard and generation fencing. Repeated-click regression.                                                                                                                  |
| UI-04 / P2  | Polling could remove the retry control after a one-shot handshake failed.               | Retain the failed action and its owner; pause observation polling and expose explicit retry with the original input. SAS-delivery retry regression.                                                |
| UI-05 / P2  | A stale `play()` rejection could stop a newer camera session.                           | Fence by disposed state and captured stream. Deferred-play regression.                                                                                                                             |
| UI-06 / P2  | Active camera scanning could change the method during SAS or replay a failed operation. | Stop/invalidate scanning before explicit actions; check owner, flow, generation and scan-eligible phase on every frame.                                                                            |
| UI-07 / P2  | A transient status error permanently erased the displayed QR.                           | Preserve the valid QR through observation failures; clear on replacement, cancellation, completion or disposal. Failed-status regression.                                                          |
| UI-08 / P2  | Resetting a terminal flow during trust refresh could leave `busy` permanently set.      | Disable reset while the operation is pending. Test failed before the fix and passed afterward.                                                                                                     |
| IPC-01 / P2 | Process receipts incorrectly described Tauri as a GUI-free stdio transport.             | Validate ready runtime, IPC kind and PID; retain session identity and accurate evidence boundaries. Negative identity tests.                                                                       |
| IPC-02 / P2 | The named subgroup still fingerprinted unrelated AccountGate CSS sources.               | Skip AccountGate JS and CSS scanning only for the named verification subgroup; retain real panel/UI CSS and all source/output checks. Final manifest has zero AccountGate and whole-locale inputs. |
| E2E-01      | QR proof completion could precede a fresh signed-key download.                          | Explicit serialized `refreshTrust`, allowed only after completion and incapable of confirming proofs. Browser tests assert both completed proof and actual device trust.                           |

The proposed redirect finding was withdrawn as **Contract misread**: the owned
loopback response writer only permits a status and body plus fixed Content-Type;
it has no Location/header injection route. The test binary is not a network
sandbox against replacing its trusted local listener or a malicious CLI caller.

The final UI finding was fixed and verified with its failing-then-passing test;
the final harness finding was fixed and verified against the compiled input
manifest. There was no fourth review cycle. This is a bounded review, not a claim that all
possible faults have been eliminated.

## Reproduction and evidence boundaries

From the repository root:

```sh
pnpm im:test:tauri
pnpm im:test:tauri:ui
# All Matrix/AccountGate persistence cases over actual webview IPC:
node tests/bot-e2e/native.mjs --tauri --browser
```

`im:test:tauri` runs the existing native verification protocol suite over real
webview invoke. `im:test:tauri:ui` runs the production panel in Chromium against
the same real system-webview IPC host. The browser tests exercise matching and
refusal, render the SDK QR modules to an optically decodable image, upload a
real image through the panel and complete the two-party protocol. These are
local Matrix server/protocol fixtures with real native cryptography, not a
live homeserver or account acceptance run.

The runner rebuilds from source and checks source/executable digests before and
after testing. The named verification subgroup builds only its panel/Vault/native
fixture plus real UI CSS; the full browser lane still builds AccountGate.
Shared AccountGate/secret-store changes correctly invalidated several broad
reruns, rather than being counted as passes. Reports live in `.cache/test-results/im-tauri-native/`,
`.cache/test-results/im-tauri-browser/` and `.cache/test-results/matrix-browser/`.
CI now has a macOS Wry lane with process/GUI evidence upload; the existing
Linux/browser/native lanes remain available. Remote CI was not executed from
this local session.

The operator UI runs in Chromium in this fixture, while actual Tauri invoke
runs in an isolated WKWebView on macOS. This does not establish normal desktop
app startup, production app ACL, hardware-camera acceptance, Windows/Linux
webview parity, real Matrix server interoperability or external IM delivery.

## Validation status

- Focused Jest: **51 passed**, including panel, wiring, binary decoder,
  MatrixVerification and native process identity/lifecycle regressions.
- Real Wry verification protocol suite: **8 passed**; final source/executable
  identities are recorded below.
- Real Chromium panel + WKWebView IPC: **4 new flows passed**, with the broader
  browser suite and final identities recorded below.
- Native runner selector regressions: **3 passed**.
- Repository and scoped ESLint, i18n build/check/lint/sort, Rust formatting, Companion catalog and
  CLI index checks: passed. Author declaration bundle regenerated successfully.
- Repository TypeScript check remains blocked by diagnostics in Transcript,
  account-sync field policy and dock-documents store;
  no diagnostics in this change's source/test paths. Static-export audit still
  reports 14 Node imports in agent-codebuff/agent-crush paths, outside this work.
- Initial attempts exposed ENOSPC and a shared Cargo lock. Only regenerable
  IM test binaries/object/library/incremental caches were removed; user
  credentials, databases, profiles and unrelated changes were preserved.

Final acceptance is the named verification subgroup, not a stale full-lane
result. Earlier in this session the full browser lane passed 16 cases (run
`f0c077cc-842b-465f-92be-a0e707e35b47`); later broad reruns were invalidated by
concurrent AccountGate/secret-store changes. The full lane remains available,
and is not claimed as verified against the latest unrelated AccountGate edits.

The preflight checks found no i18n, wiring, PII or new static-export violation.
The decoder test-gap finding was addressed with five additional regressions:
an independently encoded QR decoded by the real jsQR implementation, file
decode success, image rejection, oversized dimensions and missing canvas;
all file paths assert object-URL revocation. Coverage measurement was not run.
The fixture entry was renamed to `.tsx` to use the provider's typed JSX
children contract. No production behavior was substituted.

## Final accepted artifacts

- Protocol: **8/8 passed**, run `9a2dcd89-c001-4d7d-be3a-b44420c0475b`.
- Rendered SAS/QR panel: **4/4 passed**, including malformed PNG refusal before
  valid scan/recovery, run `ebe18fde-252e-42c1-9cb7-b119d05c7df4`.
- Both runs use native source digest `3bc466d991cda0ddb7b4d7624bf71b57a2d669b5a0a99047c5f54548a29c4f6a`
  and executable digest `efabc1702d7c8ad778266950ea474339c997d20a7ad4f7562cfb20f4e11f23e8`.
  All 12 matching process receipts are clean, retain real Wry sessions, remove
  private profiles, and finish with zero pending calls or sockets.
- Final subgroup manifest: `accountUi=false`, zero AccountGate source inputs,
  zero generated whole-locale inputs; all relevant source/output fingerprints
  remain enforced.
- Focused Jest **51/51**, native runner selection **3/3**. Full `pnpm lint`
  exited 0; scoped production/harness lint, Prettier, Rust formatting, i18n and
  catalog/index checks passed.
- Final `pnpm typecheck` reports 14 outside-scope diagnostics across Transcript,
  account-sync field policies and dock-documents store. Static-export gate
  reports 14 pre-existing Node imports in agent-codebuff/agent-crush. No full
  static export, normal app boot/ACL, camera hardware, live homeserver or remote
  CI acceptance is claimed.

Frozen reports, matching-run build/process receipts and exact gate logs:
`.cache/diagnostics/im-matrix-operator-ui-2026-10-30/`. No private profiles,
master keys, raw QR payloads or recovery keys are copied to this evidence root.
