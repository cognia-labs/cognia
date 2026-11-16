# ADR-0243 phase 4 — the delegated lane

Status: approved 2026-11-16 (Q1, Q2 decided). Implements ADR-0243 rollout item 4 (§3 "Delegated", §4) for Lark first.

## Problem

On a Lark adapter only the account the connector is signed in as can use personal features (calendar, documents, send-as-user, `lark-cli` user identity). Everyone else in the group is refused with a hint (`verifyLarkImOwnerAuthorization`, `lib/auth-providers/feishu/cli/acting-identity.ts:65`). ADR-0243 §3 replaces that owner-only gate with the **delegated lane**: a run uses its requester's own authorization, a requester who has not authorized gets a private authorization link, and the callback accepts a token only from the person the link was issued to.

## What exists and what does not

Already person-generic (phases 1–3, reused unchanged):

- `ActingIdentityV1` carries `lane`, `actingPrincipal`, `requesters` and `authorityRevision` (`packages/plugin-contract/src/types/execution/acting-identity.ts`). More than one requester already refuses personal access (`admitPersonalCredential`, `multiple-requesters`).
- Marks, effective readers, history withholding, sinks and the strict `marked-person` disclosure scope compare people with `samePersonForHost`, not with the owner.
- Private delivery routing exists for results: ephemeral card → direct chat → direct message → withheld notice (`lib/connectors/personal-delivery.ts`; Lark `send.ephemeral`, `lib/connectors/adapters/lark/ephemeral.ts`).
- ADR-0246 connection rows are keyed by principal: `authConnectionIdentityKey` = issuer, clientId, principal kind and id (`lib/db/auth-connections.ts:45`).
- 3C launches a non-owner requester's turn in its own isolated instance keyed by the requester set.
- A sender the registry maps to another Cognia account is rejected (`cross_account` → `principal.rejected`, `lib/connectors/adapters/lark/principal/unbound.ts`). Connector turns run only in the brain that owns the adapter.

One per adapter, where phase 4 needs one per person:

- **Rust storage.** The user token, refresh token and authorization epoch live under `{adapter_id}:{credential}` in the connectors secret store; `LarkUserAuthInput` (`crates/cognia-connectors/src/keyring.rs:108`) addresses snapshot, authorize, refresh and disconnect by `adapter_id` only.
- **OAuth flow.** The pending record is keyed by `adapterId` ("one authorization in flight per adapter", `lib/auth-providers/feishu/oauth-pending.ts`), carries no requester, and the callback (`handleLarkOAuth`, `oauth-handler.ts:108`) writes whoever signed in into the adapter-wide `settings.connectedUser`.
- **Connection rows.** `reconcileHostConnection` retires every other row with the same `adapterId` (`lib/plugin/auth/connection-manager.ts:483-490`), so two people's rows on one adapter would retire each other. Admission is asked with `person: adapterId` throughout (`auth.ts`, `acting-identity.ts`, `auth-bridge.ts`, `personal-credential.ts`), so "person" today names an adapter.
- **Send as user.** `sendAsUser` replies with the connected user's token (`lib/connectors/adapters/lark/index.ts`, `requireUserSendIdentity`), whoever asked.
- **Admission.** `admitPersonalCredential` (`lib/execution/personal-credential.ts`) is the kernel's single admission point but branches on `"lark-user"`, imports `@/lib/auth-providers/feishu/...` and takes a `larkContext`: vendor logic inside the kernel.
- **Lane.** Every root run records `lane: "legacy"` (`lib/execution/acting-authority.ts:490`). No adapter has a lane setting, and `AdapterInstanceRow` has no `humanRevision`.
- **3C.** `personalLaunch` (`lib/ai/agent/external/manager.ts`) admits only an owner turn to the personal profile, so a requester whose own read marked the session would be refused on the next turn.

## Decisions

### D1. One credential per (adapter, person)

The Lark user token, refresh token and authorization epoch are stored per person: secret-store account `user_token:<principal>`, `user_refresh_token:<principal>`, epoch likewise, where `<principal>` is the hex SHA-256 of the person's `open_id` (open_ids are app-scoped, so the adapter already fixes the app). Every `LarkUserAuthInput` variant gains `principal`. The owner is not special: the connector's signed-in account is the person named by `settings.connectedUser`, whose slot is read like anyone else's.

No migration: the existing `{adapter_id}:user_token` entries are dropped and the owner signs in once more (the adapter shows `needs-reauth`). This follows the repo's no-compatibility rule (Q1, decided).

### D2. The ADR-0246 connection row names the person

Each person's authorization is its own `AuthConnectionRow` (principal = their open_id, which the identity key already includes). `hostMetadata` gains `principal` (the hash from D1). `resolveLarkConnection`, `larkConnectionAdapter` and the Host connection driver (`lib/auth-providers/feishu/host-auth.ts`) resolve a connection by (adapter, principal) and never by adapter alone. `reconcileHostConnection` retires only rows of the same (adapter, principal). `connectedUser` keeps only its existing meaning: who the connector is signed in as, which is the owner (`ownerPrincipal`, `samePersonForHost`, and the owner sets built by `personal-visibility.ts`, `personal-sink.ts` and `personal-marks.ts`).

Paired clients reach `connectors_lark_user_auth` through companion RPC (`crates/cognia-companion-rpc/src/rpc/service_plane.rs`). The command's input and state gain `principal`; its entries in `protocol/companion-*-schemas.json` are edited by hand (that catalog is closed and not regenerated).

### D3. A vendor-neutral delegated-credential seam

`admitPersonalCredential` stops knowing any vendor. Its input becomes `{ source, person: PrincipalRefV1 }`, and it admits only when the run's acting identity lets that person's credential be used:

- the `delegated` lane with `actingPrincipal` the same person (`samePersonForHost`);
- a `local` or `schedule` run whose authorizing principal is the same person (the local person is the owner);
- a direct Host UI action (`LOCAL_PERSON_RUN`) for the owner.

Everything else is refused with the existing reasons. The vendor says who a credential belongs to through a new `ConnectorVendorContribution.delegatedCredentials` hook (alongside `ownerPrincipal`):

```ts
readonly delegatedCredentials?: {
  /** The person a run would use, or null when the platform has no per-user authorization. */
  personFor(row: AdapterInstanceRow, principal: PrincipalRefV1): Promise<DelegatedCredentialState>
  /** Start an authorization bound to exactly this person; returns the link to deliver. */
  beginAuthorization(row: AdapterInstanceRow, principal: PrincipalRefV1): Promise<URL>
  /** Forget this person's authorization (revoke at the platform, clear the slot). */
  revoke(row: AdapterInstanceRow, principal: PrincipalRefV1): Promise<void>
}
```

`DelegatedCredentialState` is `{ status: "authorized"; epoch } | { status: "needs-authorization" } | { status: "unsupported" }`. Lark implements it under `lib/connectors/adapters/lark/`. `verifyLarkImOwnerAuthorization`, `VerifiedLarkUserAuthorization`, `larkContext` and the `"lark-user"` owner branch are deleted; the Lark skills and `authed-api.ts` ask for the acting principal's credential instead. A platform without the hook offers the delegated lane only to the local person (ADR-0243 Consequences).

### D4. An authorization is bound to the person it was issued to

The pending record is keyed by (adapter, principal) and stores that principal. The callback verifies, before it writes any token, that the user info the token returns has the same `open_id` (and, when both carry it, the same `union_id`). On a mismatch it discards the tokens, writes nothing and answers with a fixed refusal. Several people can authorize the same adapter at once; each pending record keeps the existing 10-minute TTL and clear-on-use.

### D5. The lane is recorded at admission and set by a person

`AdapterInstanceRow` gains `credentialLane: "delegated" | "service"` (absent reads as `delegated`, the ADR's IM default) and `humanRevision`. The connector settings form writes it through a person-only path that advances `humanRevision`; no agent tool, plugin API or paired client can write it (the same shape as Bot installations, `lib/db/bot-installations.ts:192`).

The connector runtime records the lane when it creates the turn's run (`lib/connectors/runtime.ts:2461`): `lane` from the adapter, `actingPrincipal` = the single resolved requester under `delegated`, none under `service`. Recording happens once at admission and never changes; a later second requester still only tightens (existing). `legacy` remains for runs outside connectors until their own phases.

### D6. Who may authorize

Only a sender whose principal resolved (`status: "resolved"`, the registry on) can receive an authorization link. With the registry off, senders stay `legacy` and the owner-only behaviour is gone: no one but the local person gets personal access, and the reply says the registry must be enabled (Q2, decided).

### D7. The link goes out by the most private route

A requester without an authorization gets the link through the existing private-delivery routing, in ADR order: an ephemeral card in a verified ordinary group, the conversation itself when it is a direct chat with them, a direct message, otherwise a fixed notice saying where to authorize. The link card carries no content of the turn. The turn ends with that notice, and the person re-asks after authorizing; no turn is parked waiting for a sign-in.

### D8. 3C admits a requester's own marked turn

`personalLaunch` also admits an `isolated/requester` instance when every mark on the run is the run's single acting principal: that person's own data in their own turn. The instance runs as a personal gateway task exactly like an owner's (Cognia model required, loopback-only network, tool-host MCP only). Any other marked isolated turn stays refused.

### D9. Revocation and the authorized-people list

The adapter's settings page lists the people who authorized (name, time, scopes) with a per-person revoke, which calls `delegatedCredentials.revoke`. A person can also revoke their own with `/auth revoke` in a direct chat. Revoking advances that person's epoch, so a parked or resumed run re-checks and refuses (ADR §2 live checks). Disabling or deleting the adapter clears every slot.

### D10. Multi-user Hosts stay as they are

Delegated credentials live in the brain that owns the adapter, where its connector turns run. A sender mapped to another Cognia account keeps being rejected (`cross_account`), so a member's partition never receives connector tokens (ADR-0149/0253 unchanged). Account sync carries no secret; connection rows keep `hostMetadata` unsynced.

### D11. Schedules and events

- A schedule a person created from chat runs delegated as that authorizing principal only when its row records them as a resolved principal; otherwise it runs with no personal access (ADR §3 trigger table). Existing tasks without a recorded creator get no personal access, as today.
- External events never run delegated (existing `external-event` refusal, kept and covered by acceptance scenario 13).

### D12. Send as user only for the connected account

A reply goes out as a user only when the turn's acting principal is the connected account (the owner). Every other turn's reply goes out as the bot, the transport identity; a member's own token is used for their reads, never to post as them. The send-as-user toggle keeps its meaning: "my own turns reply as me".

### D13. Desktop surfaces keep reading the owner's credential

Lark docs (`lib/lark-docs/provider.ts`), twin ingest (`lib/twin/ingest/lark-doc-fetcher.ts`), issue sync (`lib/issues/sync/providers/lark-*.ts`) and the project resource dialog run for the local person, so under D3 they ask for the owner's credential. `plugins/feishu-auth` keeps its own per-principal lineage and is not changed.

### D14. Out of scope

The bound-person lane (phase 5), Bot `credentialBindings` migration to `needs_setup` (phase 5), other platforms (phase 6), the service-lane recipient grants (ADR-0239, unchanged).

## Work packages

1. **Rust per-person storage** (`crates/cognia-connectors/src/keyring.rs`, `commands.rs`, companion RPC `service_plane.rs` and `rpc.rs`, the generated companion contract, `protocol/companion-*-schemas.json`): `principal` on every `LarkUserAuthInput` and `LarkUserAuthState`, per-person accounts and epochs, drop the adapter-wide user slot and its legacy-pair adoption, `disconnect` per person and clear-all on adapter delete. In-file tests.
2. **OAuth bound to a person** (`oauth-begin.ts`, `oauth-pending.ts`, `oauth-handler.ts`): pending per (adapter, principal), identity check before any write, `connectedUser` written only by the owner's settings sign-in.
3. **Connection rows and driver** (`host-auth.ts`, `auth.ts`, `auth-retry.ts`, `authed-api.ts`, `lib/db/auth-connections.ts`, `connection-manager.ts` `reconcileHostConnection`): `hostMetadata.principal`, resolution and retirement by (adapter, principal), refresh fenced per person.
4. **Kernel admission** (`lib/execution/personal-credential.ts`, `personal-marks.ts`): vendor-neutral `admitPersonalCredential`, remove the Lark branch and types; marks name the acting principal.
5. **Vendor seam** (`lib/connectors/vendor-contribution.ts`, `lib/connectors/adapters/lark/{contribution,index,http,build}.ts`, `cli/acting-identity.ts`, `cli/auth-bridge.ts`): `delegatedCredentials`; the Lark skills, `larkUserRequest` and the `lark-cli` bridge ask for the acting principal's credential; send-as-user per D12; desktop callers per D13.
6. **Lane setting and recording** (`packages/plugin-contract/src/lib/db/connector-types.ts`, connector settings form + i18n, `lib/connectors/runtime.ts`, `acting-authority.ts`): `credentialLane`, `humanRevision`, person-only write path, recording at admission.
7. **Authorization link delivery and revocation UI** (`personal-delivery.ts`, Lark link card, `components/settings/connections/forms/lark-config.tsx` authorized-people list, `components/twin/lark-account-picker.tsx`, `/auth revoke`), i18n in both locales.
8. **3C adjustment** (`manager.ts` `personalLaunch`) with manager tests.
9. **Acceptance suite** (below), then the ADR status and docs.

WP1–WP3 land together (storage, flow and rows change shape at once). WP4–WP5 depend on them. WP6–WP8 are independent of each other.

## Acceptance tests

ADR-0243 requires its attack scenarios to pass before phase 4 ships. One suite, `lib/execution/adr-0243-acceptance.test.ts`, names each scenario and either runs it or points at the test that does. Current coverage (inventory 2026-11-16):

- Covered: 1 second-person steer, 2 child laundering, 3 later repeat, 5 operator sharing, 9 direct chat without ephemeral, 10 resumed session after a second requester, 11 migrated history, 16 unmetered engine.
- Partly, to complete in this phase: 4 summary to a shared document (end to end), 6 binding revoked while parked (revoke a delegated authorization during a parked run), 7 parallel children at the executor, 8 token export (link the SBPL keychain denial test), 14 shell after a disclosure, 15 a document the person owns but shares.
- New with this lane: 13 a webhook against a delegated adapter is refused personal access; plus the delegated cases: a non-owner's turn uses only their own token, a link opened by someone else is refused at the callback, a revoked person is refused on the next call, two people authorize concurrently.
- Waits for phase 5: 12 bound-person read triggered by someone else.

## Verification limits

Unit and integration tests cover storage, the flow, admission, lane recording and routing. Owed as a real smoke with two Feishu accounts in one group: the owner and a member each authorize, the member's calendar read answers privately, the member's link opened by the owner is refused, and revoke takes effect on the next request.

## Decided questions

- **Q1 (2026-11-16): the owner re-authorizes once.** D1 drops the adapter-wide token with no re-key; every Lark adapter shows `needs-reauth` until its owner signs in again.
- **Q2 (2026-11-16): delegated needs the principal registry.** With the registry off only the local person has personal access, including in chat; the reply names the setting to turn on.

## Outcome (2026-11-17)

WP1–WP9 are implemented. The ADR-0243 "Implementation status" section records phase 4 and the ADR-0026 amendment describes the per-person Lark gate.

What changed against the plan:

- **WP3:** `humanRevision` was dropped. Nothing reads it.
- **WP7:** `lark-config.tsx` no longer probes the old adapter-wide `user_token`/`user_refresh_token` accounts. A save keeps the per-person token names the OAuth callback added since the dialog opened. The Twin account picker names an owner only when that owner has an authorization record.
- **WP8:** the gateway-task builder rejected an isolated instance's `COGNIA_ENGINE_PROFILE` as an unknown customization, so no isolated instance could launch a personal task. The builder now drops it, and the task takes its own profile (`packages/agent-runtime-kit/src/gateway-task.ts`).

Acceptance: `lib/execution/adr-0243-acceptance.test.ts`. Scenario 6 is now run (`authed-api.test.ts`, revoke between two calls), and so are the delegated cases. Still open:

- scenarios 4 and 15 end to end: a Lark CLI document write from a marked run is checked only at the sink;
- scenario 7 at the executor;
- scenario 12, which waits for phase 5.

Known gaps:

- When `sendAsUser` is on, the authorization link cannot be an ephemeral card. It falls back to a direct message or the fixed notice.
- The authoring kit pin is invalidated by the `packages/plugin-contract` changes (`credentialLane`, `AdapterCredentialLane`) and has not been rebuilt.
- The two-account Feishu smoke under "Verification limits" has not been run.
