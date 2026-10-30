# Bot process E2E

This Playwright API project runs the Rust Host and production Brain in private
profiles. Production plugin discovery, authenticated RPC, Bot admission,
delivery runner, journals, approval interrupts and SQLite remain in the path.
The workload is an actual disk plugin. Only its external HTTP receiver is a
loopback fixture. No browser, mocked lifecycle RPC or injected executor is used.

```sh
pnpm test:e2e:bots:harness
pnpm test:e2e:bots:prepare
pnpm test:e2e:bots
pnpm test:e2e:bots:report
```

Preparation builds the current Rust Host and the production JavaScript Brain
using the existing `build-cli --js-only` entry in an independent cache folder.
This lane does not exercise native external-agent bridges. It does not change
their embedded pins. Full preparation requires at least 4 GiB free disk space.

For local diagnostics against an existing Host artifact:

```sh
pnpm test:e2e:bots:prepare -- --brain-only
pnpm test:e2e:bots
```

That receipt explicitly records `hostBuiltFromSource:false`; CI refuses it.
`COGNIA_BOT_E2E_SERVER` selects a custom binary only in this diagnostic mode.
The canonical source build resolves Cargo's real target directory. Optional
`COGNIA_BOT_E2E_BRAIN` must match the prepared receipt, including all chunks.

Preparation fingerprints the esbuild input closure, Rust/Cargo inputs,
dependency lockfile, Host binary and complete Brain output. Global setup
verifies source freshness once to select an immutable build snapshot. Each
test verifies executable bytes and snapshot identity again. Subsequent shared
worktree edits do not change the already-built snapshot; evidence identifies
the prepared source digest, rather than claiming to test later edits.

Each test creates a separate 0700 profile with synthetic keys, an explicit trust
grant for `bot-e2e` alone, disabled signaling and no inherited provider secrets.
The test preloads only that policy configuration before importing the real
Brain entry. The plugin is staged as a precondition; cogpack transfer and the
user's trust ceremony are not covered. Native RPC uses a real service token
and pins the test Host's loopback TLS identity. Paired-device DPoP, admin leases
and revocation need the separate paired Host lane.

The recorder supplies explicit barriers. Crash cases SIGKILL the test-owned
process group, reuse the same private data directory, and observe the new
process reading SQLite. Cancellation cases keep the old process alive long
enough to observe abort or a rejected late result before any restart.

## Cases

| Contract                             | Observable proof                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Install and manual idempotency       | Stable installation/delivery ID, one creation receipt, two checkpointed effects                                                        |
| Two manual triggers                  | Independent delivery/run identities for the same source key                                                                            |
| Event fanout and redelivery          | Both matching triggers execute once; self-trigger is rejected                                                                          |
| Account A/B and input-slot selection | Only the selected account admits work; effect records retain account identity                                                          |
| Credential rebinding                 | Previously accepted run is cancelled and never resumes under the new binding                                                           |
| Pause/resume                         | Pending work remains unattempted across a real crash, then drains once                                                                 |
| Running cancellation                 | Active request aborts while the old Brain remains alive; cancellation persists                                                         |
| Parked approval cancellation         | Interrupt retires, late approval is refused, no final effect                                                                           |
| Uncooperative late completion        | Returned result cannot overwrite cancelled state or publish Bot output                                                                 |
| Crash checkpoint recovery            | First committed step is not repeated; original run/delivery identity survives                                                          |
| Installation validation/removal      | Changed operation intent, absent slots and removed installation are refused                                                            |
| Native authentication                | Invalid service credential cannot mutate Bot state                                                                                     |
| Independent approval decisions       | Two parked runs retain distinct interrupt IDs/deadlines after restart; each approves once                                              |
| Denied approval                      | Denial survives restart; late approval cannot publish a final effect                                                                   |
| Approval expiry                      | Deadline equals the actual SQLite step start plus TTL; pending before expiry and resolved against that original deadline               |
| Scoped queued cancellation           | Two installations are held concurrently; cancelling one queued delivery preserves both the other installation's active and queued work |
| Provider delivery ID collision       | Two bound accounts keep distinct events/runs for the same provider ID; restart/redelivery repeats no effects                           |
| Disabled admission                   | Ignored input has a completed durable projection; enabling and redelivery cannot revive it, while fresh input runs                     |
| Uninstall with accepted work         | Running/queued work is dismissed while another installation's held and queued work each finish once                                    |

Negative contracts use bounded observations that propagate read errors. Where
RPC projections omit internal state, the harness opens only its private
profile's SQLite store read-only to inspect approval checkpoints and integration
projection completion. It never edits stored rows to create a desired outcome.
Concurrent isolation cases first occupy a runner pass, queue both targets, then
release the pass so both targets reach explicit barriers before the mutation.

## Reports and CI

HTML: `.cache/playwright-report/bots`. JSON/JUnit and per-test evidence:
`.cache/test-results/bots`. Attachments include build identities, process IDs,
redacted logs, RPC identities/statuses, interrupts and external receipts.
Private profiles and processes are removed in teardown, including failed boot.
Retries are disabled. Missing artifacts, drift and zero configured live
platforms never produce a passing acceptance result.

`.github/workflows/bot-e2e.yml` runs the harness, platform observers, fresh
build and process tests for relevant PRs and manual dispatch. It requires no
vendor credentials and uploads only the redacted reports. Adapter changes for
all built-in platforms trigger this job; its connector-contract step includes
WeCom, DingTalk and WeChat as well as the existing platform suites. Composed
Lark/Slack/Discord/Matrix observer reports live in
`.cache/test-results/im-observers/` and are uploaded alongside Bot reports.

The complementary production-adapter protocol lane is:

```sh
pnpm im:test:loopback
```

It runs WeCom, DingTalk, WeChat Personal and WeChat OA factories/transports
against real loopback HTTP/WebSocket servers through the existing Host seams.
Only the native bridge, admission gate and stores are substitutes. It does not
run a real Rust Host, model, vendor service or independent chat client. The
CLI workspace already owns the WS dependency; no new runtime dependency is
required. Fixture reports in `.cache/test-results/im-loopback/` explicitly
record this boundary, classify wire traffic without bodies/credentials, and
include pending-work counts before and after cleanup. CI runs this lane and
retains its reports. `im:test:contract` also selects DingTalk's stream-client
regressions; those are separate from local socket integration.

The native connector lane builds and runs a separate Rust process:

```sh
pnpm im:test:native
cargo test --locked -p cognia-connectors --lib
```

The first command builds the feature-gated `connector-native-fixture` binary
from current source, then reuses the enterprise loopback adapters through real
Rust HTTP/WS commands and emitted events. Additional cases drive the production
webhook router for Telegram, Slack, Discord, Lark, QQ and OA, plus OneBot reverse
WS. OA cases include encrypted signature/appId validation, held/rejected
admission and exact ACK, and two SIGKILL/restart cycles with the real encrypted
secret store. The test-only stdio transport is not Tauri IPC or a new Host API.
Normal library tests use their existing in-memory store; the separately built
native binary does not enable `test-inmemory`.

Each process uses a private generated key/profile, removed during cleanup.
`.cache/test-results/im-native/*.json` records source/binary hashes, run ID,
startup/exit/cleanup status and explicit `realPlatform:false`. Failed startup
regressions intentionally retain failure receipts; a zero pending count alone
is not a successful lifecycle. Only JSON receipts are uploaded, never profile
directories. Missing/stale native identity fails; there is no JS fallback.
Pre/post-build/test identity checks reject concurrent native source changes.
The controlled HTTP peer emits fixed headers without Location; the fixture
trusts that peer and is not an OS network sandbox for arbitrary servers.

Admission gates and Personal checkpoint stores remain fixtures in the reused
enterprise cases; the dedicated OA native cases use the actual journal. This
does not establish Tauri GUI/IPC, every native protocol, vendor accounts,
independent client observation or machine power-loss recovery.

Matrix E2EE now has a native command lane in `connector-matrix-native.test.ts`.
Two actual OlmMachines exchange signed device/one-time keys and Olm-encrypted
room keys via the loopback homeserver relay, then encrypt/decrypt Megolm room
events. SQLite profiles and store passphrases remain real and private. Cases
verify cross-device plaintext, valid-base64 ciphertext tampering, wrong room
and unshared account rejection, wrong database passphrase, identity conflicts,
close/reopen and device-public-key/Megolm recovery across actual SIGKILL.
The fixture overrides store paths into its private profile; callers cannot
supply another directory or passphrase. A narrowly scoped wrong-passphrase
probe calls the production initializer against that same private store.
The native suite also tests exact UTF-8 HTTP response budgets and WS binary
bytes, including a FIFO fence proving invalid dual-mode sends have no effect.

The same native entry also selects three composed Matrix suites:

- `connector-matrix-sync-native.test.ts` runs the production adapter, actual
  native crypto/HTTP and production DB APIs: decrypted delivery/encrypted reply,
  cursor resume, late-key recovery, admission rejection, runtime cancellation,
  initialization/close races and pending-row preservation. Its IndexedDB backend
  is Node `fake-indexeddb`; this does not prove browser disk persistence.
- `connector-matrix-media-native.test.ts` verifies actual SDK attachment
  encryption, ciphertext hashes, decrypted byte equality, encrypted native cache,
  cache hits, account/size isolation, tamper rejection and SIGKILL recovery.
- `connector-matrix-backup-native.test.ts` drives the formal running-adapter
  `keyBackup.create()` and `keyBackup.restore(recoveryKey, version?)` APIs.
  Native commands persist the recovery key before server creation, sign metadata,
  upload encrypted SDK backups and mark sessions backed up only after server ACK.
  Fresh-device restore validates the key, version and derived Megolm session IDs
  before import, then recovers a pending adapter event. Restore is bounded to
  8 MiB and 500 sessions; version metadata is bounded to 64 KiB.

An unresolved server-create outcome survives process death and is reconciled
before another create. Native UUID claims serialize independent callers and
prevent a foreign restore from overwriting an unresolved key. A proven
pre-dispatch cancellation releases only its own claim. Generic Host receipts
retain neither recovery inputs nor results; a separate canonical execution test
checks the real SQLite database/WAL. These APIs are internal service/native
commands and the existing running adapter capability; no new settings UI is
provided. Keep the returned recovery key outside generic logs and receipts.

This proves the stated native crypto, adapter, media, backup and process/store
flows against a controlled local homeserver relay. Real homeserver/client
interoperability, cross-signing, browser disk durability and Tauri GUI/IPC remain
separate acceptance work.

Real IM delivery remains a separate lane using `pnpm im:test:doctor` and
`pnpm im:test:live`. Its current two-text-turn contract now rejects extra
target replies and repeated/uncorrelated model calls. It is not an acceptance
test of every Bot executor. The proposed combined sandbox flow and remaining
executor/paired-device cases are recorded in
[the acceptance plan](../../docs/reports/2026-10-28-bot-e2e-acceptance-plan.md).

Matrix cross-signing and browser disk persistence use the existing native owner:

```sh
pnpm im:test:native
pnpm im:test:browser
```

The native cross-signing suite exercises explicit running-adapter
`crossSigning.bootstrap(auth?)` and `crossSigning.status(userId?, deviceId?)`.
Bootstrap queries the current server identity before preparing keys and refuses
partial/error self queries or a foreign identity whose private keys are absent.
It never resets identities or exports private seeds. UIA errors retain only a
bounded public challenge (`authChallenge.session/flows/params`) for an explicit
retry. Tests verify the actual SDK signature chain, forged signatures, signed
but untrusted peer devices, upload rejection, cancellation and live SIGKILL
recovery of all three public key maps/signatures.

The browser entry builds a small current-source integration bundle, then runs
real Chromium persistent profiles. It closes the whole browser process and
reopens the same profile/origin without seeding recovered data. Production
Dexie schema, CRUD, encryption middleware, Matrix adapter and native crypto/HTTP
are exercised. Cases assert exact pending rows, retry state/cursors, raw
IndexedDB encrypted envelopes, concurrent-tab deduplication, account isolation,
wrong-key rejection and late-key decryption after a rejected admission. A
separate acquisition failure case checks process/profile cleanup.

Fixture boundaries: homeserver delivery, admission policy, interactive callback
bus, default built-in seed data and the unused default Host transport are
controlled. Every invoked native command uses the real Rust subprocess. This
is browser/native storage integration, not full app UI/static-export, Tauri IPC,
real homeserver or independent-client acceptance. Profiles and generated keys
are private and removed; only redacted JSON results are uploaded. Browser
assertions/config/runner/build helpers and compiled inputs/outputs have source
identity checks in `.cache/bot-e2e/matrix-browser/build.json`; native build/run
receipts use `.cache/test-results/im-browser-native/`. The exact fixture seams
are in `matrix-browser-setup.mjs`, not production bundle hooks.

Vault-backed Matrix cases now provision/unlock the production Browser Vault
with its normal Argon2id parameters (19,456 KiB, two passes), persist the
connector credential there, and reopen the account cipher from the Vault after
full browser restart. No raw DEK is supplied in those cases. The earlier raw-key
CRUD cases remain separate. Tests cover password rotation, account-bound
recovery, valid-encoding wrap tampering, exact ciphertext preservation on failed
authentication and locking during a completed real WebCrypto credential decrypt.
The decrypt is held only to control timing; it is never replaced with a fake.
The production session now rejects late plaintext after lock and clears its
temporary plaintext buffer.

Native sync cases also verify encrypted events across two non-empty backfill
pages with an empty middle page, a later-page failure followed by full retry,
and stop/restart while a real native backfill response is held. They assert the
actual `since`/`to` cursors, oldest-first payloads and composite message IDs.
These continue using the explicit Node IndexedDB backend of the native-only
lane; the separate Chromium tests establish browser storage behavior.

The AccountGate entry additionally mounts the production gate, lock screen,
account-store singleton and initializer with real registry, Vault, runtime-target
selection, database boot and built-in seeding. Actual forms cover creation,
per-key recovery acknowledgement, wrong passwords/keys, recovery password reset,
account switching and full browser restart with exact Matrix data/credential
restoration. Raw Vault and account snapshots must survive failed authentication.
It uses production styles with a bounded Tailwind source scan. Navigation and
the unused execution broker are explicit shell seams; Node/browser shims match
the Next build. This is rendered component integration, not the full app shell.

The native verification suite drives actual SDK SAS/QR through the production
command and running-adapter verification capability. It compares both SAS
representations, checks explicit mutual confirmation/cancellation, valid-base64
MAC tampering, QR key/flow binding, incoming sync discovery, identical transaction
retry and SIGKILL trust persistence. QR bytes are the SDK's actual protocol
payload; camera hardware and optical decoding are not exercised. Interactive
state is ephemeral and cleared at native close/restart. The internal command
uses HostSemantic receipts so QR shared secrets are not copied into receipts.

Neither entry establishes secret-sharing, full-app static export, Tauri IPC,
real homeserver/client interoperability or actual camera scanning.
Adapter cursor/config rows follow the existing secret-externalized metadata
policy; pending content and Vault credentials are checked for encrypted storage.
