# ADR-0246 P9a runtime matrix evidence

Date: 2026-11-03

This report records code-level enforcement evidence in `runtime-support.evidence.test.ts`.
The final scoped Jest invocation passed **22 suites and 418 tests**, including the
40 cases below and the separate completeness case.

## Evidence boundary

The tests drive real `connectProvider`, confidential-exchange/client-secret guards,
connection credential persistence adapters, callback acceptors/routers, plugin network
request dispatch, and the integration runtime initializer. Platform sensors, native
keychain bridges, vendor transport and process startup are boundary doubles. Headless
secret persistence also exercises the real CLI file store in a temporary directory.
These results do not establish real vendor sign-in, native keychain availability,
actual CORS headers, minimized-process scheduling, or browser visual acceptance.

## Behavior changes

- One pure matrix defines four profiles and ten facets, with typed availability,
  reason and recovery. Environment detection stays in a separate module so the
  matrix does not import React or native transport code.
- Auth checks run before migration, prompts and authorization. Headless redirect
  methods and plugin device-code return structured refusals. Device-code remains
  visible and disabled, including on desktop.
- API-key setup uses a masked Host-only input and `describe`, without exchange,
  expiry or refresh. Credentials commit through the existing uniqueness/CAS path.
  The Host-selected method is persisted outside the provider credential payload.
- HTTP 401 marks only an API-key connection as `needs-reauth`, preserving account
  health updates and OAuth behavior. Credential revision fences reject stale 401s;
  malformed JSON cannot bypass the mark. Host and legacy OAuth drivers are excluded.
- Confidential OAuth uses authorization code without a PKCE verifier. Confidential
  exchange and client-secret operations share matrix refusals and recovery details.
  Vault and gateway refusals no longer become generic INTERNAL errors.
- Mobile PKCE uses `cognia://auth/callback`; the shared parser and Capacitor router
  deliver it to the Host acceptor. Headless external callbacks are refused.
- Diagnostics combine manifest declarations, provider method prerequisites,
  background-sync permission and non-Host network domains. All blocked methods
  yield an error; partial method support, background sync and CORS yield warnings.
- Manifest honesty warnings live in the **Host collector**, because the zero-Host-
  alias plugin-contract package cannot import the Host matrix.
- Plugin detail, method picker and External Services show common reasons/recovery.
  Pairing links to `/pair`; vault recovery opens the existing AccountGate unlock
  path. API keys never enter plugin settings or configuration storage.
- The initializer consults the local sync facet. Standalone Capacitor retains its
  mobile auth profile; active remote gateways use effective tauri for hosted
  exchange/network. Paired clients never install a second local sync drain.
- Seven first-party manifests declare honest runtime support. Example Tracker's
  auth implementation still calls the trusted exchange API even with placement
  `none`, so standalone browser/mobile are explicitly blocked. Headless consumers
  can use existing connections, while initial public PKCE remains blocked.
- Both author-SDK docs contain the exact matrix rendering, pinned by drift tests.
  Contract types document dormant device-code and carry optional diagnostic
  reason/recovery fields. No contract catalog change was needed.

## One evidence case per cell

| Profile  | Facet                            | Exact Jest test name                              |
| -------- | -------------------------------- | ------------------------------------------------- |
| browser  | `auth-method:oauth-pkce`         | `ES-33 browser × auth-method:oauth-pkce`          |
| browser  | `auth-method:oauth-confidential` | `ES-33 browser × auth-method:oauth-confidential`  |
| browser  | `auth-method:client-credentials` | `ES-33 browser × auth-method:client-credentials`  |
| browser  | `auth-method:device-code`        | `ES-33 browser × auth-method:device-code`         |
| browser  | `auth-method:api-key`            | `ES-33 browser × auth-method:api-key`             |
| browser  | `auth:confidential-exchange`     | `ES-33 browser × auth:confidential-exchange`      |
| browser  | `auth:callback`                  | `ES-33 browser × auth:callback`                   |
| browser  | `secrets:persistent`             | `ES-33 browser × secrets:persistent`              |
| browser  | `network:cross-origin`           | `ES-33 browser × network:cross-origin`            |
| browser  | `sync:background`                | `ES-33 browser × sync:background`                 |
| tauri    | `auth-method:oauth-pkce`         | `ES-33 tauri × auth-method:oauth-pkce`            |
| tauri    | `auth-method:oauth-confidential` | `ES-33 tauri × auth-method:oauth-confidential`    |
| tauri    | `auth-method:client-credentials` | `ES-33 tauri × auth-method:client-credentials`    |
| tauri    | `auth-method:device-code`        | `ES-33 tauri × auth-method:device-code`           |
| tauri    | `auth-method:api-key`            | `ES-33 tauri × auth-method:api-key`               |
| tauri    | `auth:confidential-exchange`     | `ES-33 tauri × auth:confidential-exchange`        |
| tauri    | `auth:callback`                  | `ES-33 tauri × auth:callback`                     |
| tauri    | `secrets:persistent`             | `ES-33 tauri × secrets:persistent`                |
| tauri    | `network:cross-origin`           | `ES-33 tauri × network:cross-origin`              |
| tauri    | `sync:background`                | `ES-33 tauri × sync:background`                   |
| mobile   | `auth-method:oauth-pkce`         | `ES-33 mobile × auth-method:oauth-pkce`           |
| mobile   | `auth-method:oauth-confidential` | `ES-33 mobile × auth-method:oauth-confidential`   |
| mobile   | `auth-method:client-credentials` | `ES-33 mobile × auth-method:client-credentials`   |
| mobile   | `auth-method:device-code`        | `ES-33 mobile × auth-method:device-code`          |
| mobile   | `auth-method:api-key`            | `ES-33 mobile × auth-method:api-key`              |
| mobile   | `auth:confidential-exchange`     | `ES-33 mobile × auth:confidential-exchange`       |
| mobile   | `auth:callback`                  | `ES-33 mobile × auth:callback`                    |
| mobile   | `secrets:persistent`             | `ES-33 mobile × secrets:persistent`               |
| mobile   | `network:cross-origin`           | `ES-33 mobile × network:cross-origin`             |
| mobile   | `sync:background`                | `ES-33 mobile × sync:background`                  |
| headless | `auth-method:oauth-pkce`         | `ES-33 headless × auth-method:oauth-pkce`         |
| headless | `auth-method:oauth-confidential` | `ES-33 headless × auth-method:oauth-confidential` |
| headless | `auth-method:client-credentials` | `ES-33 headless × auth-method:client-credentials` |
| headless | `auth-method:device-code`        | `ES-33 headless × auth-method:device-code`        |
| headless | `auth-method:api-key`            | `ES-33 headless × auth-method:api-key`            |
| headless | `auth:confidential-exchange`     | `ES-33 headless × auth:confidential-exchange`     |
| headless | `auth:callback`                  | `ES-33 headless × auth:callback`                  |
| headless | `secrets:persistent`             | `ES-33 headless × secrets:persistent`             |
| headless | `network:cross-origin`           | `ES-33 headless × network:cross-origin`           |
| headless | `sync:background`                | `ES-33 headless × sync:background`                |

Completeness case: `ES-33 completeness: every matrix cell has exactly one named enforcement case`.
Its independent profile/probe list must equal all matrix keys and contain no duplicates.

## Remaining verification boundary

The ordinary `pnpm lint:i18n` exits 4 while the repository's generated aggregates
remain frozen: three literal references require newly added split-source keys.
The split locales assemble correctly and the lint passes against isolated generated
previews. `i18n/messages/en.json` and `i18n/messages/zh-CN.json` must be regenerated
by the orchestrator as explicitly required by the brief; this job does not write them.

Browser inspection was attempted. agent-browser could not create its socket directory
under the sandbox; the alternate browser tool reported that its access host was
unavailable. The UI has RTL interaction evidence, without a real-browser screenshot.

`lib/integrations/runtime.ts` and `lib/integrations/runtime.test.ts` were not edited.
