# Evidence ledger: ocr tool support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-09
- Related: ADR-0024; ADR-0059; ADR-0250; `plugins/ocr/`; `packages/ocr/`
- Baseline: `8ca2394da3e1c15cb077b95ec4b8d457a525c7ba` on `dev`; shared checkout, 2026-11-08 Asia/Shanghai.
- Repair baseline: `dd892e4a10` on the shared checkout, 2026-11-09 Asia/Shanghai.
- Review baseline: `9f0832300044734fd8f74161d249002c380685d3` on the shared checkout, 2026-11-09 Asia/Shanghai.

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在对OCR工具调用的支持情况，看看存在什么bug或者缺口

## Audit result

The first audit identified nine finding groups. All ten original characterization probes still reproduce on the review baseline. The adversarial review narrows the impact of F3, F6 and F8 and adds F10–F16. Six additional Node probes and a controlled Chromium PDF-worker comparison exercise the new findings. The reviewed runtime paths use source inspection, synthetic OCR inputs and isolated transport or host resources.

The companion `2026-11-08-ocr-tool-support-audit.probes.mjs` is a separate evidence artifact because extending production tests to assert defective behavior would legitimize the defect. It bundles checked-out source and substitutes only host-resource seams (screen capture, persistent settings/storage, credentials, native backend listing, UI registration). It preserves routing, provider request construction, cache lookup, port dependency construction and tool filtering. Raw summaries land in `.cache/ocr-tool-support-audit/probes.json`.

## Support snapshot at audit baseline

| Surface                          | Current support                                                                                                                                                                    | Evidence and qualification                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main agent tool                  | Startup-activated `cognia-ocr` registers `ocr.extract`; advertised sources are top-level `path`, `data_url`, and `screen`. Languages, format, provider and pageRange are accepted. | `plugins/ocr/src/index.ts:167`, `:217`; product-profile includes the plugin. Registration does not establish successful provider execution.                                                                                                                              |
| Sidecar Claude / AI SDK          | Plugin manifests flow through the existing relay. Dotted names have model-facing aliases, then restore their original dispatch name.                                               | `lib/plugin/bridge/sidecar-tools-bridge.ts:125`; `sidecar/src/policy/tool-catalog/plugin-aliases.ts`; `model-names.ts`. Source inspected; live-model turn not run.                                                                                                       |
| Standalone browser / mobile BYOK | Renderer-executable tools exist, but this OCR tool is removed by standalone name validation.                                                                                       | F7. This does not mean the OCR package itself cannot run in a browser.                                                                                                                                                                                                   |
| Inline image                     | Data URLs are mapped to the host OCR port, which loads saved settings and resolves credentials/cache through `hostOcr`.                                                            | `plugins/ocr/src/index.ts:135`; `lib/plugin/api/ocr-api.ts:178`. Existing tests and composed probes cover dispatch, not image recognition accuracy.                                                                                                                      |
| File path                        | Default plugin API reads through Tauri filesystem only. Sidecar metadata declares read access and top-level `pathParams`.                                                          | `plugins/ocr/src/index.ts:224`; `lib/plugin/api/ocr-api.ts:142`. Browser/mobile/headless default file resolver rejects paths. No live confinement/ACL acceptance in this audit.                                                                                          |
| PDF                              | A real text-layer/rasterization/streaming PDF subsystem exists, and document-cloud adapters can accept PDF data. The generic agent tool does not compose that PDF router.          | `packages/ocr/src/pdf-router.ts:105`; `lib/ocr/port.ts:20`; F2. Attachment PDF fallback calls `extractPdf` separately.                                                                                                                                                   |
| Screen via `ocr.extract`         | Uses desktop automation capture, then OCR through the module port.                                                                                                                 | `lib/automation/ocr-screen.ts:63`; F4. Provider override and saved settings are not preserved. Browser/mobile direct desktop-screen source is unsupported.                                                                                                               |
| Separate screenshot OCR tool     | `cognia-screenshot` also registers `extract_screenshot_ocr`, with picker/native capture, monitor/region controls, block geometry and optional image output.                        | `plugins/screenshot/src/index.ts:437`; browser picker is consent-based; native mode uses automation permissions; mobile manifest is blocked. It calls `ctx.ocr.extract`, so unlike `ocr.extract` screen mode it loads saved OCR settings. F9 concerns opt-out filtering. |
| Slash command                    | `/ocr` parses paths/attachment-like ids and provider/language/pages/format flags; plugin emits an OCR result card.                                                                 | `lib/slash-commands/actions/ocr.ts`; F5. Default runtime supplies a file resolver but no attachment resolver.                                                                                                                                                            |
| Computer Use OCR fallback        | `find_text` and `click_text` locate OCR blocks within the current app revision and use the existing automation/click gates.                                                        | `plugins/computer-use/src/index.ts:478`; `lib/automation/ocr-click.ts` uses `extractWithOcrPort`, so the settings-default issue in F4 also reaches this helper. Coordinate/click behavior was not exercised in this audit.                                               |
| Workflow                         | `ocr.extract` executor supports data URL, base64, URL and screen, using the OCR port.                                                                                              | `lib/workflow/nodes/data/ocr.ts:82`. Without supplied deps it uses package defaults, like the screen path (F4 scope). Workflow UI was not exercised.                                                                                                                     |
| Providers                        | Runtime registers 20 provider descriptors spanning cloud, vision, native, WASM and local HTTP. Plugin-contributed providers are namespaced and lifecycle-cleaned.                  | `lib/ocr/runtime.ts:58`; `lib/plugin/api/ocr-api.ts:76`. Registered is not synonymous with ready: keys, OS bindings, compiled features, downloaded models and plugins still matter.                                                                                      |

## Findings

### F1 — P1: disabling cloud fallback still permits automatic cloud dispatch

`packages/ocr/src/auto-router.ts:159` gates only the explicit cloud-fallback phase. The final `listForShell` loop at line 167 re-adds all ready providers, including cloud providers. With `cloudFallbackEnabled: false`, a failing local engine can therefore fall through to a configured cloud adapter anyway. The same final loop can automatically choose `local-http`, contrary to ADR-0024's user-pinned-only description.

Probe F1 uses a failing synthetic `tesseract-wasm` plus a ready synthetic cloud adapter: cloud calls = 1 with the flag false. A control that explicitly disables that cloud provider prevents its call, so this finding is about the fallback policy, not a general bypass of `providerEnabled`. No network data was sent. Existing `auto-router.test.ts` actually expects a last-resort cloud provider with fallback disabled; that assertion records the conflicting behavior rather than disproving this finding.

Impact: unexpected image/screen data egress and provider charges when local OCR fails. Repair: apply the cloud-fallback policy and user-pinned-only local HTTP policy to every automatic candidate phase, with explicit-provider selection specified separately.

### F2 — P1: tool PDF handling bypasses the PDF router; page range is ineffective

`lib/plugin/api/ocr-api.ts:178` and `:183` call `ocr.extract` for inline/file sources. `lib/ocr/port.ts:19` forwards to generic extraction. `packages/ocr/src/index.ts:262` then forwards the resolved blob unchanged to a provider; it never chooses `extractPdf`, a text-layer fast path, or rasterization for image-only engines. The default local engines are image recognizers. For example, Paddle uses `image::load_from_memory` (`crates/cognia-ocr/src/backend/paddle.rs:111`), not a PDF renderer.

Probe F2a confirms `%PDF-1.7` and MIME `application/pdf` reach the native Paddle invocation unchanged. The native decoder is replaced with a rejecting fixture; an actual Rust decoder/native OCR run was not performed. Source establishes the image-only decoder. This is not a claim that every PDF/provider pair fails: Mistral has its own PDF request shape.

Even that document-cloud path drops `pageRange`: `packages/ocr/src/providers/mistral-ocr.ts:71` never sends it, and its result mapping at line 84 never filters pages. Probe F2b requests page `2` of a synthetic PDF input, captures a `document_url` request with no page selection, and receives pages `[1, 2]` unchanged. No live API semantics or real billing were tested.

Impact: a PDF can fail on the default local route, incur an unintended cloud retry, or process more pages than requested. Repair: compose the existing PDF router for image-only engines, preserve native-document provider paths where intended, and enforce page selection at a clearly owned boundary.

### F3 — P1: cache identity ignores page range and provider configuration

`packages/ocr/src/cache-contract.ts:18` contains only file digest, provider id and languages. Generic extraction reads/writes that identity at `packages/ocr/src/index.ts:272` and `:294`; the persistent implementation uses the same identity in `lib/ocr/cache.ts:33`.

Probe F3 reads the same file with page range `1`, then `2`, then a changed model. All return `1:old`; provider calls = 1. The page-sensitive provider is synthetic, but the core cache lookup and key contract are real. The changed-model case is independently wrong even while built-in adapters ignore pageRange.

The model/config defect affects the current whole-result cache. The page-range counterexample uses a synthetic page-sensitive provider. The current built-in Mistral path ignores the range before caching, so a second distinct built-in page-cache defect was not reproduced. The review also found a current language-order collision. `lib/db/ocr-results.ts:38` sorts languages for identity, while `packages/ocr/src/providers/ocr-space.ts:71` and `packages/ocr/src/providers/local-http.ts:165` consume the first language. Swapping `en` and `zh` therefore preserves the key but changes the provider request.

### F4 — P2: screen OCR loses provider override and persisted settings

`plugins/ocr/src/index.ts:122` passes only languages to `extractScreen`; provider and format are discarded. `lib/automation/ocr-screen.ts:59` calls `ocr.extract(input)` without deps. The port constructs `buildOcrDeps()` at `lib/ocr/port.ts:19`, which uses `DEFAULT_OCR_SETTINGS` rather than loading the person's saved settings.

Composed probe F4 supplies a saved provider `fixture-saved`, saved language `zh`, and an explicit screen-tool provider override. A control using loaded settings selects `fixture-saved`; the real plugin → screen → port chain instead selects `tesseract-wasm` and language `en`. Only capture/storage/credentials are fixtures. Ordinary workflow `ocr.extract` calls without deps share the default-settings issue by source inspection. The separate screenshot plugin calls the settings-aware `ctx.ocr.extract` and is not included in this specific finding.

The same settings omission reaches the Composer image action. `components/chat/composer.tsx:682` invokes `useOcr()` without deps and `hooks/use-ocr.ts:25` builds package defaults. The preview's OCR buttons are in the image branch (`components/chat/composer/attachment-preview-dialog.tsx:397`), so this observation concerns manual image OCR. The PDF attachment send path uses a different loader (F14).

### F5 — P2: `/ocr --provider auto` tries to resolve a provider literally named `auto`

The parser accepts `--provider auto`, but `lib/slash-commands/actions/ocr.ts:162` assigns it directly to `providerId`. Generic extraction treats every defined provider id as explicit, so `resolveProviderById` fails. The agent tool already normalizes `auto` to undefined; the slash path does not.

Probe F5 uses the same file fixture and registry: no flag succeeds; `--provider auto` yields `OCR provider "auto" is not registered.` Repair: normalize auto at the canonical request boundary and add a real extraction composition regression test.

### F6 — Mobile native recognition is unshipped and readiness is incomplete

`lib/ocr/deps.ts:164` reports `backend-not-bound` for every local provider other than WASM/local HTTP unless the platform is Tauri or headless. Both mobile-native implementations exist (`lib/ocr/providers/apple-vision.ts`, `mlkit-android.ts`), but their mobile readiness is never checked here.

Probe F6 evaluates production readiness with fixture provider descriptors. Both return `ready: false`, `reason: backend-not-bound`. The checked-in mobile manifest and lockfile also lack `@pantrist/capacitor-plugin-ml-kit-text-recognition`, which both mobile adapters require (`lib/ocr/providers/mlkit-android.ts:66` and `lib/ocr/providers/apple-vision.ts:115`). The installed barcode scanner has a different purpose. The original P2 readiness defect applies to a build with the text recognition binding. The standard checkout has a packaging gap as well, and a readiness fix alone would leave native OCR unavailable.

### F7 — P2: standalone BYOK agents cannot see `ocr.extract`

`lib/ai/chat/standalone-tools.ts:51` rejects dots in names and drops rejected entries at line 82. The OCR tool is registered with a dot. Sidecar adapters already alias dotted names, but standalone does not.

Probe F7 builds the real standalone map with `ocr.extract` and an underscore-only control tool. Only the control survives; rejected = `["ocr.extract"]`. Repair: reuse reversible model-name aliasing and restore original names for execution/events. This audit independently reproduces the same compatibility issue noted in the neighboring builtin-tool audit; it is not a new missing registration.

### F8 — P2: native Tesseract readiness compares different identifiers

Rust's `TesseractBackend::id()` is `tesseract` (`crates/cognia-ocr/src/backend/tesseract.rs:30`), and `ocr_list_available_backends` returns backend ids unchanged (`crates/cognia-ocr/src/native.rs:202`). The TypeScript provider id is `tesseract-native`. `lib/ocr/deps.ts:169` checks `backends.has(provider.id)` without mapping it to the backend id.

Probe F8 extracts the id from the Rust source and returns it from the native-list fixture. Production readiness rejects `tesseract-native`; a same-id control is ready. `lib/ocr/deps.test.ts:108` currently supplies the wrong list value `["tesseract-native"]`, masking the real boundary mismatch. Repair: centralize provider-to-backend mapping and pin a contract test against actual backend ids. Availability of a locally installed Tesseract binary was not tested.

The mismatch affects builds with `ocr-tesseract` enabled. The standard desktop defaults select only `ocr-paddle` (`src-tauri/Cargo.toml:531`), and compiled-out Tesseract is a placeholder (`crates/cognia-ocr/src/backend/mod.rs:37`). Its binding and the presence of the Tesseract executable are separate prerequisites.

### F9 — P2: OCR opt-out filters one plugin but leaves screenshot OCR

`lib/claude/ocr-tool-gate.ts` treats `enableOcr: false` and IM `allowOcr: false` as denials. `lib/claude/build-options.ts:3468` applies the denial only to plugin id `cognia-ocr`. The independently registered `cognia-screenshot` tool `extract_screenshot_ocr` (`plugins/screenshot/src/index.ts:437`) survives that filter and still calls `ctx.ocr.extract`. The character UI describes the setting as removing image text extraction (`i18n/messages/en/settings/characters.json:109`). Whether the switch should also cover `find_text` and `click_text` under separately enabled Computer Use remains a product scope decision.

Probe F9 executes the exact isolated production filter with a false verdict and both manifest entries; only screenshot OCR remains. This is a narrow filter proof, not a full send-options or native capture run. Plugin enablement, semantic pruning and screenshot/automation permissions still apply; this finding does not claim a bypass of OS capture consent. Repair: apply an OCR capability veto across all OCR-performing tool entries while retaining separately authorized non-OCR screenshot functionality.

## Adversarial review additions

### F10 — P1: Reply Copilot can send a local-only screen read to cloud OCR

ADR-0194 §8 requires on-device OCR for the captured chat window. `lib/reply-copilot/screen/local-ocr.ts:61` picks a local candidate and passes it explicitly, but hands unchanged settings to extraction. `packages/ocr/src/index.ts:281` still applies confidence escalation to that explicit call. `packages/ocr/src/confidence.ts:53` can select the saved cloud fallback without checking the fallback switch, provider-enabled state or readiness. The settings allow cloud escalation for ordinary OCR, while the Reply Copilot contract separately restricts the private screenshot.

F10 runs the production Reply Copilot wrapper, OCR port, core and Mistral request builder against a synthetic low-confidence local result. The request interceptor received the original image with cloud fallback off and the cloud provider disabled. With confidence escalation off, the same fixture stayed local and the request count remained one. The HTTP transport was a local interceptor. The source also treats `local-http` as a local candidate even though it may send the frame to a configured LAN endpoint.

### F11 — P1: IM capability checks miss eager OCR and alternate capture routes

The Inbox switch promises that disabling OCR leaves inbound attachments unread (`i18n/messages/en/inbox.json:337`). `lib/connectors/bus.ts:807` runs OCR on inline image bytes before reading the adapter and resolving the sender. `lib/connectors/inbound-ocr.ts:124` only checks the global `ocrInboundImages` preference and builds extraction from the user's saved settings. The conversation opt-out and adapter OCR ceiling do not govern this branch. With cloud routing configured, the same branch can dispatch the image to a cloud provider. F11 exercised the exact eager branch with the production inbound wrapper and a fixture image. The IM tool verdict was false and OCR text still appeared. Turning off the global preference suppressed it. This isolates the branch, not an actual IM delivery.

The send-options path separately defaults IM Computer Use to denied, but that filter only removes `cognia-computer-use`. The OCR plugin still accepts `source.kind: "screen"` and the screenshot plugin still accepts native mode when those entries are available. Native host policies still apply and the picker still requires user selection. The parent ceiling in `lib/connectors/im-permission-ceiling.ts:44` lists only the Computer Use tools and `ocr.extract` aliases for these capabilities. Bot-owned IM sessions add another source-confirmed gap. `lib/plugin/api/agent-turn.ts:125` records `imAuthorityBinding` without `platformBinding`. `lib/claude/build-options.ts:1830` and `:3377` use `platformBinding` for capability checks and only use the authority binding for content safety. These projection paths were inspected without a live bot or native capture run.

### F12 — P1: file OCR checks a different path than it reads

The tool advertises paths within the workspace (`plugins/ocr/src/index.ts:170`). The sidecar generic policy deliberately permits out-of-root noncredential reads (`sidecar/src/policy/confinement/classify.ts:76`). OCR then passes the path to the desktop filesystem API without a workspace root (`lib/plugin/api/ocr-api.ts:142`). In addition, the policy uses the untrimmed string while `plugins/ocr/src/index.ts:109` trims it before dispatch.

F12 used only synthetic scratch paths. The real classifier added no restriction to an ordinary out-of-root file, denied the exact `.netrc` fixture and added no restriction to the trailing-space variant. The OCR handler passed the trimmed `.netrc` path to the read stub. The Tauri filesystem ACL remains independent, and this probe established the policy and reader mismatch without reading an actual file or credential.

### F13 — P2: cancellation stops waiting while OCR work can continue

`lib/plugin/core/invoke-plugin-tool.ts:425` supplies the attempt signal, but the OCR callback (`plugins/ocr/src/index.ts:230`) ignores it. In F13 an in-flight synthetic Mistral request received no signal and returned success after the caller aborted. The sidecar Stop path separately drains its pending response promises (`sidecar/src/host/index.ts:314`) and the renderer bridge forwards a plain execution request (`lib/claude/plugin-tool-dispatch-bridge.ts:53`). A fresh reviewer also aborted a real WASM adapter call with a deferred recognizer fixture. Once released, the core returned the result, wrote the cache once and notified once. `packages/ocr/src/index.ts:222` only checks cancellation at entry. The related `click_text` path can still reach `performAction` after OCR returns (`lib/automation/ocr-click.ts:267`), conditional on valid state and native authorization. No actual clicks were issued.

### F14 — P1: cold PDF attachment OCR fails to start its worker under desktop CSP

The attachment send path reaches the PDF router (`lib/chat/attachments/pdf-ocr-fallback.ts:156` and `lib/ocr/port.ts:20`). Its loader imports the package-main PDF.js module and sets an external `.js` worker URL when the module has no worker configured (`packages/ocr/src/pdf-loader.ts:17`). The installed PDF.js 6.3.289 provides `pdf.worker.min.mjs`. The artifact PDF viewer imports the separate legacy module (`plugins/cognia-pdf/src/pdf-engine.ts:125`), so its worker setting does not initialize this module.

The fresh reviewer and the main review each ran a local Chromium experiment using the checked-out loader, installed PDF.js, exact configured Tauri CSP and a real one-page PDF. Fresh pages started with an empty worker setting. The default branch reported `Setting up fake worker failed` after the CSP blocked the external script. The same-origin installed `.mjs` worker control rendered a 30 × 30 PNG under the same policy. Both recorded zero external requests. This proves the cold loader behavior under the configured policy. The deployed Tauri WebView and external CDN response remain untested.

### F15 — P2: a cache failure can replace successful local OCR with cloud OCR

The core wraps provider execution and cache writes in the same retry catch (`packages/ocr/src/index.ts:279`). The persistent cache propagates write failures (`lib/ocr/cache.ts:53`). F15 injected a write rejection after a successful local result and observed one cloud call and a cloud result. The `useCache: false` control returned local output without an additional cloud call. The fresh review also reproduced a separate cache gap after confidence escalation. The repeated input executed both providers again because cache lookup uses the primary candidate and the escalated result is written under the final provider id (`packages/ocr/src/index.ts:272`, `:294`).

### F16 — P2: slash output flags do not change the delivered format

The slash parser accepts `--format text`, but both command output and composer text use `combinedMarkdown` (`lib/slash-commands/actions/ocr.ts:168`). F16 supplied distinct plain text and Markdown and received the same Markdown for both flags. The first-party plugin also appends the same result card for either `--into` choice (`plugins/ocr/src/index.ts:248`). The common `effectiveFormat` helper has no production callers, and built-in providers do not consume the generic `format` field. This leaves that field as a possible extension point for third-party providers.

### Additional source findings

- Page ranges expand before the document's page count is applied. An enormous range consumes work on a one-page document, and unsafe integer endpoints can prevent the counter from advancing (`packages/ocr/src/image-prep.ts:118`). Existing tool and slash routes bypass this parser. The attachment loader already creates its canvas before imposing a pixel bound (`packages/ocr/src/pdf-loader.ts:84`). Extreme inputs were inspected statically.
- The package exports streaming PDF OCR, but the current production attachment path does not call `extractPdfStreaming`. It also leaves `ocrPage` unset, so rasterized pages use the package default and skip app OCR usage metering (`lib/ocr/port.ts:22`, `packages/ocr/src/pdf-router.ts:95`).
- One failing fallback readiness check can abort construction of the entire candidate list before a ready local provider runs. The fresh reviewer verified this with a throwing readiness fixture. Production credential lookups can propagate errors (`packages/ocr/src/auto-router.ts:138`, `lib/ocr/deps.ts:203`).

## Other gaps and limits

- Attachment ids are deliberately absent from the tool's advertised enum: the production plugin runtime has no attachment resolver. The lower-level type still accepts them, and `/ocr att_*` parses them, but the default runtime cannot resolve them (`lib/plugin/api/ocr-api.ts:178`). A model cannot use a chat attachment id end to end through this API today.
- Headless has server-safe native OCR registration, but the default plugin file resolver explicitly requires `detectPlatform() === "tauri"` (`lib/plugin/api/ocr-api.ts:147`). File-based tool support therefore does not follow automatically from server-native OCR support. No headless live-agent turn was run.
- `isReady` / `listAvailableProviders` count registered providers, not ready providers (`lib/plugin/api/ocr-api.ts:99`, `:175`). With startup registering all descriptors, this is a weak readiness signal; routing may still find no executable candidate. Treat this as an observability/API gap, not proof that every registered provider is unusable.
- Windows.Media.Ocr remains an explicitly unavailable placeholder (ADR-0024 and `crates/cognia-ocr/src/backend/mod.rs`). This is a known platform deliverable, not a newly discovered regression.
- Existing OCR-named Tauri E2E covers listing and a Probe-button UI round trip. The extraction spec installs `__cogniaE2EOcrMock` before selection/dispatch; it does not establish agent-tool → provider/native execution. No E2E or real-shell UI run was performed here.
- No fixes, OCR accuracy comparison, real-provider credentials, downloads, OS permission prompts, real screens, phone devices or deployed-build checks were part of this audit. Repository-wide typecheck/lint/build and coverage were not run because production code was unchanged; focused existing tests, source composition probes and artifact checks are the evidence below.

## Recommended repair sequence

### Repair verification — 2026-11-09

The findings and characterization probes above describe the pre-repair checkout. The seven P1 items were repaired and verified first. F7 was already repaired in the branch before this pass; F13 needed work beyond the existing Stop relay.

| Item     | What changed                                                                                                                                                                                                                                                                                                                         | Regression and result                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · P1  | Automatic routing respects the cloud fallback switch and only picks local HTTP when pinned. An explicitly saved cloud default remains an intentional selection.                                                                                                                                                                      | `auto-router.test.ts`: the formerly unconditional cloud fallback is excluded, including when all local providers fail.                                                                                                                                                                                                                    |
| F2 · P1  | Image-only engines receive rasterized pages within the selected range. PDF-capable engines retain their native paths. Mistral receives [zero-based page selections](https://docs.mistral.ai/api/endpoint/ocr) and defaults to OCR 4.1, including saved 4.0 configs [after retirement](https://docs.mistral.ai/resources/changelogs). | Core and Mistral regressions: the fixture rasterizes only page 2, preserves its OCR cost, and the captured provider request contains the compact page selection. No live provider request.                                                                                                                                                |
| F3 · P1  | Cache identity includes MIME, page range, format, model/configuration, the PDF text-layer setting, and applicable escalation policy; it preserves language order. Existing whole-result keys miss the new namespace.                                                                                                                 | Core, cache and Dexie tests cover a model change and ordered language keys.                                                                                                                                                                                                                                                               |
| F10 · P1 | Explicit engine selection cannot escalate. Reply Copilot permits only the built-in engines that recognize images on device.                                                                                                                                                                                                          | Low-confidence explicit OCR stays local; the Reply Copilot selection test rejects local HTTP.                                                                                                                                                                                                                                             |
| F11 · P1 | IM inbound OCR runs after admission and the conversation and adapter checks, on-device only. Projection and dispatch cover Bot authority bindings, and screen-capable tools follow the IM Computer Use ceiling.                                                                                                                      | ConnectorBus, gate, send-options and invocation tests cover opt-out, allowed inline image, Bot binding, a rewritten screen source, and the nested ceiling. Live Bot/OS capture was not run.                                                                                                                                               |
| F12 · P1 | The original path is checked and read beneath the session workspace by the native binary reader. Sensitive paths, traversal and sandbox-to-desktop fallback are denied.                                                                                                                                                              | Plugin API and sandbox regressions cover padded, external and sandboxed paths, and the IPC fixture asserts `allowSensitive: false`. The Rust workspace reader passed its round-trip, traversal and sensitive-file assertions.                                                                                                             |
| F14 · P1 | The build stages the version-matched PDF.js worker; the OCR loader overrides stale worker settings and rejects oversized canvases before allocation.                                                                                                                                                                                 | Loader regressions pass. Real Chromium under Cognia's CSP rendered a 30 × 30 PNG with zero external requests. This did not exercise the installed Tauri WebView.                                                                                                                                                                          |
| F4 · P2  | Screen, Composer and workflow OCR honor saved settings, and screen requests keep explicit provider and format. Agent overrides respect provider enablement; protected workflows restrict raw OCR inputs to on-device engines.                                                                                                        | Port, plugin, Composer hook and workflow regressions cover the saved preferences, explicit options and the protected workflow route.                                                                                                                                                                                                      |
| F5 · P2  | `/ocr --provider auto` uses the same provider selection as an omitted flag.                                                                                                                                                                                                                                                          | Slash parser/extraction boundary test compares both requests.                                                                                                                                                                                                                                                                             |
| F6 · P2  | The mobile build includes Pantrist 8.1.1. Readiness checks the OS and the native `CapacitorPluginMlKitTextRecognition` bridge. Mobile block mapping accepts iOS box ordering.                                                                                                                                                        | Frozen install, Android and iOS `cap update` and iOS pod install passed; both generated native registries contain the plugin. Tests cover missing bridge, wrong OS, native proxy dispatch and iOS geometry. The installed binding uses the Latin recognizer; the iOS provider ID is retained for compatibility. No device accuracy claim. |
| F7 · P2  | Existing commit `6ab49f6e43` already implements reversible standalone tool aliases.                                                                                                                                                                                                                                                  | The existing OCR-specific collision regression ran: `ocr.extract` and `ocr_extract` receive distinct model-facing names and dispatch to their canonical names.                                                                                                                                                                            |
| F8 · P2  | TypeScript maps `tesseract-native` to the Rust registry ID `tesseract`.                                                                                                                                                                                                                                                              | The real-shaped headless transport fixture reports the provider ready; no claim about the opt-in feature or executable on a given machine.                                                                                                                                                                                                |
| F9 · P2  | OCR opt-out removes OCR extraction, screenshot OCR and Computer Use find/click text. Raw screenshots retain their separate policy.                                                                                                                                                                                                   | Send-options and live-gate tests cover opt-out and the raw screenshot control.                                                                                                                                                                                                                                                            |
| F13 · P2 | Existing commit `f84c18fc37` forwards Stop to plugin attempts. This pass threads the signal through OCR and prevents late results, cache writes and text clicks.                                                                                                                                                                     | Delayed-provider and screen/click regressions abort after work starts and observe no late publication or click. Native work already in progress may still finish internally.                                                                                                                                                              |
| F15 · P2 | Cache I/O failures do not cause provider retries. Escalated results are cached under the eligible primary request and miss when the target is no longer allowed.                                                                                                                                                                     | Cache read/write failure fixtures preserve the local result; repeating a successful escalation calls each provider once, and disabling fallback cannot replay the cloud result.                                                                                                                                                           |
| F16 · P2 | Slash output uses the selected text, Markdown or blocks format. Composer output is a draft; system output is delivered to chat.                                                                                                                                                                                                      | Parser, plugin, composer adapter and rendered Composer tests verify output formats, original quoting, system fallback, and draft insertion without sending a model turn.                                                                                                                                                                  |

The first P1 check passed 16 suites and 290 Jest tests, plus six focused authorization cases and one Rust test. The final combined run and repository checks are listed under Verification commands.

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                       | State    | Basis                                                                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | OCR is exposed as startup-activated `cognia-ocr` plugin tool `ocr.extract`, with file, inline-data and screen inputs.                                                           | Observed | `plugins/ocr/src/index.ts`, `plugin.json`; source audit 2026-11-08.                                                           | -          |
| G1  | Audit current OCR tool support and identify actionable bugs or gaps with evidence.                                                                                              | Agreed   | Exact user request, 2026-11-08.                                                                                               | -          |
| C1  | Preserve concurrent changes; audit production code without changing runtime behavior or publishing anything.                                                                    | Verified | Shared working tree status and task scope, 2026-11-08.                                                                        | -          |
| Q1  | Do tool entry points preserve PDF, settings, cache and platform contracts through the real composition roots?                                                                   | Answered | F1–F9 and source/probe evidence, 2026-11-08; several contracts are not preserved.                                             | O1         |
| O2  | Cloud fallback false still permits cloud dispatch after local failure; local HTTP may enter automatic last resort.                                                              | Verified | Probe F1; current source, synthetic ready providers, 2026-11-08.                                                              | O1         |
| O3  | PDF tool dispatch bypasses the PDF router and Mistral request construction ignores pageRange.                                                                                   | Verified | Probes F2a/F2b plus Rust image-decoder source; no live PDF/native recognition, 2026-11-08.                                    | O1         |
| O4  | Result-cache lookup reuses output across page-range/model changes.                                                                                                              | Verified | Probe F3; real core with memory cache matching production identity, 2026-11-08.                                               | O1         |
| O5  | The screen tool drops provider override and uses default rather than saved settings.                                                                                            | Verified | Composed probe F4; synthetic capture and settings persistence, 2026-11-08.                                                    | O1         |
| O6  | Slash provider auto is treated as a literal provider id.                                                                                                                        | Verified | Probe F5; real parser and core, fixture file resolver, 2026-11-08.                                                            | O1         |
| O7  | Mobile-native readiness fails early, and native Tesseract id mapping is inconsistent.                                                                                           | Verified | Probes F6/F8; real resolver, Rust-source id, fixture native listing; no device run, 2026-11-08.                               | O1         |
| O8  | Standalone tool filtering drops the dotted OCR name.                                                                                                                            | Verified | Probe F7; actual standalone map plus control, 2026-11-08.                                                                     | O1         |
| O9  | The OCR denial manifest filter preserves the screenshot plugin OCR tool.                                                                                                        | Verified | Probe F9; exact isolated filter and real pure gate; no full send-options/capture run, 2026-11-08.                             | O1         |
| G2  | Recheck the audit for false positives, overstated impact and omitted failure paths.                                                                                             | Agreed   | User requested adversarial review, 2026-11-09.                                                                                | G1         |
| O10 | Mobile native text recognition is absent from the checked-in standard build. The desktop Tesseract mismatch is conditional on the opt-in feature.                               | Verified | Mobile manifest and lockfile, mobile loader, desktop Cargo features and native registry, 2026-11-09.                          | O7         |
| O11 | Local-only screen OCR can escalate to cloud. The inbound eager branch and alternate tool paths evade portions of the IM capability checks.                                      | Verified | F10/F11 and three independent source reviews, with the bot and native tool projections scoped to source evidence, 2026-11-09. | O2,O9      |
| O12 | OCR file path checking and reading diverge. The OCR callback drops attempt cancellation.                                                                                        | Verified | F12/F13 with the real policy and handler, synthetic paths and a fixture HTTP transport, 2026-11-09.                           | O1         |
| O13 | The cold attachment PDF loader fails under desktop CSP while the same-origin worker control renders. Cache failure can change provider, and slash text output retains Markdown. | Verified | Chromium F14 and Node F15/F16, 2026-11-09.                                                                                    | O3,O4      |
| G3  | Repair F1–F16 with the seven P1 findings first, add targeted regressions, and record the per-item evidence.                                                                     | Agreed   | Exact user request, 2026-11-09.                                                                                               | G1,G2      |

## Problem frame

Audit the checked-out source and deterministic behavior of OCR invocation (G1), from plugin tool discovery and host API to extraction, routing, caching, settings and platform boundaries. Deliver a support matrix and prioritized reproducible findings. Production changes, external provider charges, real screen capture and deployment are outside this research task (C1). A green mock suite alone does not establish real OCR accuracy.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                             |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| scale        | medium | Plugin, host port, shared package, native backends and agent adapters.                                  |
| technical    | medium | Multiple OCR backends; inspect contracts rather than infer behavior from provider labels.               |
| coupling     | high   | Browser, desktop, mobile and headless share a core but use different resources.                         |
| requirement  | low    | Read-only research; no prescribed fix or disputed product choice.                                       |
| verification | high   | Deterministic composition checks are available; real providers and devices are separate acceptance.     |
| risk         | low    | Audit artifacts only; discovered security/privacy risks are assessed without exercising private inputs. |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                                              | Severity | Source                                                               | Claim                                                                         | Refuted by                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Advertised OCR inputs/options fail in a real tool call.                                                    | high     | ADR-0024; FMEA entry-point lens                                      | Source kinds, PDFs and options reach the appropriate pipeline.                | A composed call drops options or sends PDF bytes into an image-only backend.                                                                |
| R2  | Stale cache returns another extraction's output.                                                           | high     | ADR-0024 cache contract                                              | Cache identity distinguishes output-affecting options.                        | Same file/provider/languages with different pages/config returns prior output.                                                              |
| R3  | Tool availability or permission differs from actual runtime capability.                                    | high     | Cognia risk catalog: wiring and cross-shell; ADR-0059                | Discovery reflects executable routes and confinement.                         | Registered tools are filtered or an advertised shell route cannot execute.                                                                  |
| R4  | Tests conceal disconnected composition roots.                                                              | medium   | Evidence skill verification reference                                | Report differentiates unit behavior, source proof and real environment.       | Only mocked delegates are tested while real wiring fails.                                                                                   |
| R5  | OCR processes private inputs beyond the authorized device, conversation, file scope or execution lifetime. | high     | ADR-0194 §8, Inbox OCR copy, tool schema and attempt signal contract | Local-only, opt-out, scoped path and cancellation decisions survive dispatch. | Intercepted cloud request from local-only screen read, eager OCR after opt-out, different checked/read paths or in-flight work after abort. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk           | Method                                                                              | Independence   | Evidence                                                                                                                                                                                                                        | Coverage                                                                                                           | Status  |
| --- | -------------- | ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1,R3          | Trace plugin registration, agent projection, port and provider dispatch.            | self           | Source paths and exact line references recorded in Support snapshot and Findings; F7/F9 pin two projection failures.                                                                                                            | Current source; no deployed-build claim.                                                                           | passed  |
| V2  | R1,R2,R3       | Run focused existing Jest suites and deterministic counterexample probes.           | tool           | Two `pnpm test --runInBand` runs: 10 suites/139 tests and 9 suites/112 tests passed. `node --test docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs`: 10 probes reproduced the named defects. Commands recorded below. | Synthetic provider responses/capture/storage/native listing; no credentials or real screen.                        | passed  |
| V3  | R3,R4          | Inspect native/headless/mobile capability and tests; label real-environment limits. | self           | Rust backend ids/decoder, mobile readiness branch, plugin shell manifests, runtime boot and mock E2E inspected. Limits recorded explicitly.                                                                                     | Source-backed capability audit; no real device/provider acceptance.                                                | passed  |
| V4  | R4             | Check ledger and final task diff.                                                   | tool           | Final ledger, formatting, probe rerun and scoped Git inspection recorded in Verification commands.                                                                                                                              | Only this ledger and companion probes authored by this task.                                                       | passed  |
| V5  | R1,R2,R3,R4,R5 | Challenge the support claims against current source and exercise counterexamples.   | fresh-reviewer | Three fresh-context reviewers audited routing, authority and PDF/input contracts. The main review reconciled their findings and ran 16 Node probes and both Chromium worker branches.                                           | Synthetic data, actual Chromium with configured CSP and installed PDF.js, source trace for Bot/native projections. | passed  |
| V6  | R1,R2,R3,R5    | Reproduce and verify each numbered repair with scoped behavioral tests.             | tool           | Per-item table, final combined Jest run, and the Rust workspace read test below.                                                                                                                                                | Application and adapter seams, with synthetic data.                                                                | passed  |
| V7  | R3,R4          | Validate packaging, static export, types and actual worker loading.                 | tool           | Frozen install, both Capacitor updates, scoped ESLint, mobile typecheck, i18n, and Chromium verification; full typecheck blocked as noted in X4.                                                                                | No device recognition, provider call, or deployed-build acceptance.                                                | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                   | Action    | Based on                      | Reversal trigger                                                                   |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| D1  | 2026-11-08 | Diagnose current support with source traces and local counterexamples; do not implement fixes during the audit.                            | diagnose  | G1,C1,O1                      | User requests fixes or evidence changes task scope.                                |
| D2  | 2026-11-08 | Deliver a prioritized audit with nine finding groups; keep runtime acceptance and repairs open.                                            | diagnose  | G1,C1,O2,O3,O4,O5,O6,O7,O8,O9 | Real composition evidence disproves a finding, or user authorizes repairs.         |
| D3  | 2026-11-09 | Retain the original probe results, narrow their product impact where applicable and add F10–F16. User chose to skip external model review. | diagnose  | G2,O10,O11,O12,O13            | A live runtime or packaging test contradicts a reviewed boundary.                  |
| D4  | 2026-11-09 | Implement the authorized repairs, run P1 regressions before proceeding to P2, and retain existing fixes for F7 and the F13 relay.          | implement | G3,O2,O3,O4,O7,O11,O12,O13    | A regression contradicts the repair or a real environment exposes a remaining gap. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                             | From        | Why still open                                                                                                                                                             | Next action                                                                                                         | Status |
| --- | ---------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | F1–F16 implementation and regression coverage were open at the audit baseline.                       | R1,R2,R3,V6 | The per-item repair table records the implementation or verifies the existing fix.                                                                                         | Keep the targeted tests in the standard suites.                                                                     | closed |
| X2  | Live provider, OS capture and device acceptance remain unverified.                                   | R1,R3,R4,V7 | Provider HTTP and screen capture are fixture-based; the Chromium worker experiment used the app CSP. Native plugin packaging was verified without a phone recognition run. | Run opt-in acceptance using synthetic image/PDF fixtures on Tauri, iOS, Android, and the configured cloud provider. | open   |
| X3  | Unnumbered attachment-id, headless file/PDF and unavailable backend gaps remain outside this repair. | R3,R4       | The host has no OCR attachment resolver, headless file OCR still lacks a supported file surface, and image-only headless PDF requires an actual raster environment.        | Track separately from the numbered regressions.                                                                     | open   |
| X4  | Repository-wide typecheck is blocked by unrelated working-tree errors.                               | R4,V7       | The normal command stops in `tmp/ui-polish/picker-head.tsx`; a run excluding that scratch directory exposed unrelated storage, memory and sidecar diagnostics.             | Re-run the full gate once the shared worktree errors are resolved.                                                  | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                         | How / when measured                                                         | Result                                                                                                                | Status |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Actionable support matrix and prioritized findings delivered.                  | This ledger, companion probes and final Chinese report, 2026-11-08.         | Nine finding groups with source/probe evidence; repair order and actual validation limits recorded.                   | met    |
| M2  | Adversarial audit reconciled with current implementation.                      | Fresh-context review plus current source and controlled probes, 2026-11-09. | Original failures reproduced, platform and cache impact narrowed, seven new groups recorded with evidence boundaries. | met    |
| M3  | Numbered repairs are covered by regressions with explicit evidence boundaries. | Per-item repair verification and final test run, 2026-11-09.                | F1–F16 have repair evidence; F7 was already fixed and verified on this baseline.                                      | met    |

## Verification commands

Executed from the repository root on macOS/Apple Silicon, Node `v26.12.1`, 2026-11-08. The root Jest entry point chose the configured `node` project. No coverage command was used.

```sh
pnpm test --runInBand plugins/ocr/src/index.test.ts lib/plugin/api/ocr-api.test.ts lib/automation/ocr-screen.test.ts lib/claude/ocr-tool-gate.test.ts packages/ocr/src/index.test.ts packages/ocr/src/auto-router.test.ts packages/ocr/src/pdf-router.test.ts lib/ocr/port.test.ts lib/ocr/deps.test.ts lib/slash-commands/actions/ocr.test.ts
# 10 suites, 139 tests passed

pnpm test --runInBand plugins/screenshot/src/index.test.ts packages/ocr/src/providers/mistral-ocr.test.ts packages/ocr/src/providers/paddle-ocr.test.ts packages/ocr/src/providers/tesseract-native.test.ts lib/ocr/providers/apple-vision.test.ts lib/ocr/providers/mlkit-android.test.ts lib/ocr/cache.test.ts lib/ocr/runtime.test.ts lib/ai/chat/standalone-tools.test.ts
# 9 suites, 112 tests passed

node --test docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs
# 10 characterization probes reproduce the named failure conditions

pnpm exec prettier --check docs/evidence/2026-11-08-ocr-tool-support-audit.md docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-08-ocr-tool-support-audit.md --final
git diff --check -- docs/evidence/2026-11-08-ocr-tool-support-audit.md docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs
```

Initial probe-harness setup exposed an unintended dependency expansion through the native transport import, then a mistaken harness assumption that a map with only rejected tools is returned rather than undefined. Both were corrected in the audit harness before the ten-probe run; neither is reported as a product defect. CodeGraph CLI was available but no project index existed, so navigation fell back to literal search and owning-source reads. Concurrent unrelated working-tree changes were preserved.

On 2026-11-09 the review reran the original ten probes and then ran all sixteen with `node --test --test-timeout=15000 docs/evidence/2026-11-08-ocr-tool-support-audit.probes.mjs`. The retained Chromium repro runs from the repository root with `node .cache/ocr-tool-support-audit/pdf-worker.mjs`. The default branch failed to load its worker and the same-origin control rendered one 30 × 30 PNG. Three fresh-context reviews contributed the routing, authority and PDF counterexamples. The user chose to skip additional cross-model review.

The review Jest run included `lib/connectors/inbound-ocr.test.ts`, `lib/connectors/bus.runtime.test.ts`, `lib/connectors/im-permission-ceiling.test.ts`, `lib/reply-copilot/screen/local-ocr.test.ts`, `packages/ocr/src/confidence.test.ts`, `packages/ocr/src/pdf-loader.test.ts` and `plugins/ocr/src/index.test.ts`. Six suites passed. The full ConnectorBus suite failed 29 tests and passed 22 in its isolated rerun. Its `@cognia/redact` mock omits `normalizeForRedaction` (`lib/connectors/bus.runtime.test.ts:48`), which the downstream content safety code calls. The OCR-specific inbound gate passed by itself (`-t 'runs inbound OCR only'`, 1 passed). The complete suite log is `.cache/ocr-tool-support-audit/bus-review.log`.

On 2026-11-09 the repair pass used the same shared checkout, with the numbered test cases above. A fresh preflight review caught the mobile bridge name and iOS box ordering, checked test placement and draft wiring, and verified that model-owned screen options and protected workflow OCR cannot bypass provider enablement or binary egress policy. The i18n audit found no new UI strings or translation keys.

```sh
pnpm test --runInBand packages/ocr/src lib/ocr lib/db/ocr-results.test.ts lib/claude/ocr-tool-gate.test.ts lib/claude/build-options.test.ts lib/claude/plugin-tool-dispatch-bridge.test.ts lib/ai/chat/standalone-tools.test.ts lib/connectors/im-permission-ceiling.test.ts lib/connectors/inbound-ocr.test.ts lib/connectors/bus.runtime.test.ts lib/slash-commands/actions/ocr.test.ts lib/slash-commands/plugin-commands.test.ts lib/plugin/api/ocr-api.test.ts lib/plugin/core/invoke-plugin-tool.test.ts lib/files/workspace-fs.test.ts lib/reply-copilot/screen/local-ocr.test.ts lib/automation/ocr-screen.test.ts lib/automation/ocr-click.test.ts lib/workflow/nodes/data/ocr.test.ts lib/workflow/nodes/integrations/index.test.ts lib/sandbox/session-runtime.test.ts hooks/use-ocr.test.ts plugins/ocr/src/index.test.ts plugins/screenshot/src/index.test.ts plugins/computer-use/src/index.test.ts components/chat/composer.test.tsx
# 77 suites, 1,777 tests passed.

cargo test -p cognia-files --lib read_workspace_file_base64 --offline
# 1 passed

pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir mobile exec cap update android
pnpm --dir mobile exec cap update ios
pnpm --filter mobile typecheck
# All passed; iOS pod install succeeded and both native manifests list the plugin.

pnpm ocr:copy
cmp public/ocr/pdf.worker.min.mjs node_modules/pdfjs-dist/build/pdf.worker.min.mjs
node .cache/ocr-tool-support-audit/pdf-worker-fixed.mjs
# Both Chromium runs loaded the staged 6.3.289 worker and rendered a 30 × 30 PNG.
# No external requests.

pnpm lint:static-export
pnpm lint:i18n
pnpm i18n:sort:check
# Passed; static-export audited 12,409 TypeScript files.
# Scoped ESLint (--max-warnings 0), Prettier, and git diff --check passed on the repair paths.

pnpm typecheck
# Blocked by tmp/ui-polish/picker-head.tsx(168,1): error TS1005: '}' expected.
# The same root compiler run with tmp excluded reported no diagnostics on the
# OCR repair paths; unrelated storage, memory and sidecar diagnostics remain.

node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-08-ocr-tool-support-audit.md --final
```
