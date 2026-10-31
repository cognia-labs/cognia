# Provider production and interface validation

Date: 2026-10-31 (Asia/Shanghai). Environment: macOS arm64, Node 26.12.1.
Scope: production build and real interface verification of the Provider/brand
convergence, preserving unrelated concurrent work. No new product defect was
confirmed and no product source was changed during this validation.

## Build results

| Check                                                                                                                                                             | Exit | Observed result                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `COGNIA_DISABLE_WEBPACK_CACHE=1 pnpm build`                                                                                                                       | 1    | Stops at the first prebuild step, native Agent bridge pin verification; Next is not reached.                                       |
| `COGNIA_DISABLE_WEBPACK_CACHE=1 pnpm exec cross-env NODE_OPTIONS=--max-old-space-size=16384 node scripts/build/with-plugin-artifacts.mjs -- next build --webpack` | 0    | Full configured Next production compilation and static export succeed: compilation in 3.2 minutes, 129/129 static pages generated. |
| `pnpm typecheck`                                                                                                                                                  | 2    | 14 diagnostics across eight files outside the Provider change. Sidecar typecheck is not reached.                                   |
| `pnpm lint`                                                                                                                                                       | 1    | 31,149 findings: 1,399 errors / 29,750 warnings, all in 271 generated files under existing `cli/.cache/plugin-extraction-js/`.     |
| `pnpm lint:static-export`                                                                                                                                         | 1    | 14 Node-only imports in agent-codebuff / agent-crush.                                                                              |
| Focused Jest run, including Provider projection and Kimi plugin declarations                                                                                      | 0    | 9 suites / 354 tests passed.                                                                                                       |

The cache flag only disables webpack's disk cache. No compiler, plugin-artifact,
static-export or integrity check was relaxed. The direct Next invocation is a
separate stage check, **not a passing result for the full `pnpm build` pipeline**.
The repository's existing Next configuration skips in-build typechecking; the
separate failed typecheck above must therefore remain visible.

Artifacts are under `.cache/provider-brand-production-20261031/`: `build.log`,
`next-build.log`, `typecheck.log`, `typecheck-summary.json`, `lint.log`,
`lint-summary.json`, `static-gate.log`, `tests.log`, and `source-state.json`.
The recorded load-bearing Provider/build source fingerprints did not change
during compilation or interface validation.

## Real interface checks

Served the newly generated `out/` on loopback port 3145 with the repository's
static server, using `--skip-e2e-marker-check` because this is the normal
production export, without the E2E bridge. Browser automation used the in-app
browser. The unavailable agent-browser CLI was not installed.

Created an empty local test profile on this new origin, selected offline use,
and skipped provider credentials. Existing accounts/settings were not changed.
The custom Provider fixture points only to the task's loopback resource server,
has one synthetic model, and has no API key. No inference or subscription request
was used to validate image rendering.

| Interface action                                                 | Result                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Open AI Connections, filter and select OpenAI                    | Sidebar/header use `/icons/lobe/openai.svg`; decoded image has nonzero natural dimensions.                                               |
| Filter Qwen, OpenCode and Zhipu                                  | Qwen, OpenCode Go and Zhipu rows use their correct local SVG paths and decoded successfully.                                             |
| Filter/select llama.cpp                                          | No image element; deterministic `L` monogram. A missing local inference server reports a separate connection failure, not a broken logo. |
| Add a custom Provider named `Private Gateway (icon validation)`  | Sidebar/header display the `P` fallback; the row contains no image element.                                                              |
| Change the test profile from system-dark to Light via Appearance | OpenAI remains loaded and legible on the white tile in both themes.                                                                      |
| Open `settings?section=subscription&subTab=accounts`             | Correct capability refusal: “Not available on this host”. Desktop plugin activation/brand override cannot be accepted from this browser. |

All 142 existing brand aliases resolve to 85 unique local resources. Every
resource is present in the new export, is byte-identical to its `public/` source,
and returned HTTP 200 from the static server. The final OpenAI view had no
console errors and all its `/icons/` images were decoded successfully.

Evidence:

- `local-resources.json`, `export-resources.json`, `provider-ui-evidence.json`,
  `browser-image-health.json`, `browser-errors.json`.
- `openai-production.png` and `openai-production-light.png`.
- `fallback-production.png` and `custom-fallback-production.png`.
- `subscription-host-unavailable.png`.

The CDN URL generation contract remains covered by shared tests. This run does
not establish remote CDN availability for arbitrary unknown Provider IDs. The
real UI uses the observed monogram fallback for those identities.

## Separate blockers and ownership

### Native bridge prebuild pins

`scripts/build/lib/stage-native-agent-bridges.mjs:86` rejects the current bridge
closure before the production command can continue. Expected source hashes and
the esbuild version match. An independently compiled Hermes probe differs from
the pinned output by an emitted `code;` class field. None of the four native
bridge input closures includes brand-assets, Provider icon metadata, or the
models.dev map; removing the new brand source alias in an in-memory compiler
control produces the same Hermes output.

Evidence: `native-pins-audit.json`, `native-pin-control.json`,
`hermes-output-diff.txt`. The relevant native bridge owner should review the
compiler/class-field semantics and intended bytes before explicitly updating
pins. This task did not run `--pin`, edit pins, or bypass integrity verification.

### Repository type diagnostics

The 14 diagnostics are in:

- `components/bots/sections/triggers-section.test.tsx`
- `components/tray-panel/tray-panel-delegate-bar.test.tsx`
- `hooks/automation/use-sandbox-desktop.test.ts`
- `lib/connectors/adapters/_shared/a2ui-mapper.test.ts`
- `lib/db/integrations.test.ts`
- `lib/sandbox/session-runtime.test.ts`
- `plugins/feishu-auth/src/oauth.test.ts`
- `plugins/feishu-auth/src/oauth.ts`

These are untouched/concurrent files outside the Provider scope; no new brand
or Provider metadata diagnostic was reported. Their owners need to repair the
actual contracts before repeating the global type gate.

### Generated CLI cache and static-export gate

The existing CLI plugin-extraction cache is outside the Provider change. Global
ESLint currently traverses that generated code. Its owning build/lint integration
needs to establish the intended cache exclusion; no generated file was patched
and no existing cache was deleted here. The separate static-export gate flags
14 imports in agent-codebuff / agent-crush despite the configured Next build
succeeding; those native/browser ownership rules need a separate resolution.

### Desktop subscription acceptance

Kimi and the other declarative subscription plugins intentionally require the
desktop credential vault. Their manifest explicitly blocks browser/mobile
activation. `node scripts/tauri/agent-debug.mjs status` reported
`bridge_unavailable`; there is no valid current debug Host. The normal debug
launch's `beforeDevCommand` invokes `pnpm dev`, whose first predev step is the
same failing native bridge pin check. No host capability or runtime policy was
weakened to force a browser pass.

The namespaced `brandId` override remains covered by the real ProviderIcon/unit
registry contract and Kimi manifest tests, but **real desktop plugin activation
and its displayed brand are unverified**. After the native build blocker is
resolved, launch a valid Tauri debug Host and repeat the Kimi provider path with
its declared brand; do not substitute a browser test for that acceptance.

The previously documented 16 external Agent brand gaps remain separately owned
by `docs/reports/2026-10-30-external-agent-brand-gaps.md`.

Both task-owned loopback servers (3045 and 3145) and temporary browser tabs were
closed after evidence capture. No existing application cache or user profile was
deleted. Product/build source fingerprints remained unchanged at final review.
