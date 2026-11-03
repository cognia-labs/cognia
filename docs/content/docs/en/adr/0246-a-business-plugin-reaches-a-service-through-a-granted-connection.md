---
title: "0246 — A business plugin reaches a service through a granted connection"
description: "A base plugin (Feishu, Google, …) adapts one vendor's sign-in and protocol and provides an auth service. Business plugins (calendar, docs, tasks, backup) declare that service, get an opaque connection reference, and act through Host-injected credentials under their own consumer grant. The Host owns the connection's identity, refresh, rotation, logout and callbacks; built-in Rust providers implement the same contract."
---

# ADR 0246 — A business plugin reaches a service through a granted connection

**Status:** Accepted (2026-11-01); implemented through step 5 (2026-11-03)
**Date:** 2026-10-31
**Related:** [ADR-0026](./0026-plugin-extension-point-expansion) (integrations), [ADR-0126](./0126-plugin-subsystem-governance) (plugin trust posture), [ADR-0134](./0134-remote-document-providers) (docs providers), [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched) (capability grants), [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings) (always-on Host), [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request) (outbound authorization), [ADR-0243](./0243-a-run-acts-for-someone-and-says-who) (acting identity and credential lanes)

## Context

The direction is to split vendor support into a **base plugin** per vendor (sign-in, accounts, protocol adapter) and **business plugins** per domain (calendar, docs, drive, tasks, IM, backup) that depend on it, with UI, agents and workflows using public interfaces, and built-in capabilities moving onto the same SDK.

An adversarial review (ledger: `docs/reports/2026-10-31-external-service-plugin-architecture-adversarial-review.md`, items ES-01 to ES-36) found that the public SDK exposes parts of auth and integrations, but not a contract for permissions, lifecycle, migration or domain reuse. The first fix batch closed the defects that did not need a design (ES-01–06, 13, 14, 18–22). What remains needs decisions:

- **Session identity is thin.** `AuthSession` has `id`, `accessToken`, `account {id,label}` and `scopes`. `getSession` returns the first session whose scopes are a superset of the request. There is no issuer, client, tenant, principal kind or purpose, so two accounts of one vendor, or two clients, cannot be told apart by a consumer (ES-07).
- **Authorization is not layered.** A remote OAuth grant, the Host's stored session and a business plugin's right to use it are one thing today. `CapabilityGrant` in the external-services control plane names a connection, account, workflow and session, but no consumer plugin. A shared login therefore widens every consumer (ES-08).
- **Provider identity was a bare string.** Commit b119bd3f9e binds a provider id to the first plugin that registers it, until uninstall. Connections still do not record which provider package, publisher or contract version they belong to (ES-09).
- **Refresh, rotation and logout have no cross-window owner.** Google's Rust controller (`crates/cognia-connectors/src/google_docs_auth.rs`) uses nonce compare-and-swap and a disconnect fence, in one process. The Feishu base plugin under development dedups refresh in a per-instance `Map`. The plugin auth registry has no lock (ES-10).
- **Callbacks are validated per consumer.** The Rust relays (`axum_app.rs`) forward `code`/`state` without validation; each consumer checks state. Single use, binding to client and issuer, cancellation and late callbacks are not one rule (ES-11).
- **The auth method range is unstated** (ES-12), **the base-plugin upgrade order** (ES-15) and **owner takeover** (ES-16) are not accepted contracts, and **"a library plugin serves business plugins"** has no definition of interface version, account scope, permission propagation or invalidation (ES-36).
- **Data outlives access.** Remote documents reach search indexes, RAG embeddings, chat attachments, dock snapshots and history. Nothing says what happens to them when a connection is disconnected, its access is revoked, or the remote item is deleted (ES-23).

The plugin trust posture stays as ADR-0126 defines it: frontend plugins are semi-trusted and run in the Host realm. This ADR is about an honest contract between plugins and the Host, not a sandbox.

## Decision

### 1. Three layers of authorization

| Layer | Owned by | What it says |
| --- | --- | --- |
| **Remote grant** | The vendor | What the vendor allows the stored token to do (its scopes). |
| **Connection** | The Host | One remote grant stored by the Host for one identity (§2), with its credentials, refresh lineage and status. |
| **Consumer grant** | The Host, per business plugin | Which operations (and resources) one business plugin may use through one connection, at one connection revision. The scopes it asks for must be on that revision; they are checked when the grant is made and not stored as a second allowlist, because the operations already bound what the consumer can call. |

A business plugin acts only through a consumer grant. Adding scopes to the remote grant creates a new **connection revision**. It does not widen any existing consumer grant: each consumer that needs the new scopes asks again.

Consumer grants extend the existing `CapabilityGrant` with `consumerPluginId` and `connectionRevision`. `authorizeExternalCapability` checks both. Agents and workflows that call a business plugin's tools are authorized by that plugin's consumer grant plus the run's own checks (ADR-0198, ADR-0239). They never get a wider grant than the plugin they call.

### 2. A connection has a stable identity

A connection's identity is the tuple:

- **provider**: provider id, owning plugin id, publisher, provider contract major version
- **issuer**: the deployment or issuer (e.g. `open.feishu.cn` vs a Lark international or private deployment; the account's deployment origin)
- **client**: the OAuth client id or app id that holds the grant
- **tenant**: the vendor tenant or organization, when the vendor has one
- **principal**: the remote account id and its kind, `user`, `bot` or `service`, mapped to ADR-0243's credential lanes (`user` → delegated or bound person; `bot`/`service` → service)

Plugins hold a **connection reference**: an opaque, Host-issued id. They never construct or parse it.

**Selection.** When a business plugin asks for a connection without naming one, the Host binds the only connection that matches the plugin's required provider and scopes. If several match, the user picks once for that plugin, and the binding persists. UI, agents and workflows of that plugin all use the same reference; nothing picks "the first matching session".

**Purposes share a connection.** One remote grant backs one connection. Different purposes are different consumer grants on it. Because the Host keeps one lineage per (issuer, client, principal), a separate connection for one purpose needs a separate OAuth client; a consumer can then be bound to it.

**The client is part of the identity.** Two OAuth clients are two remote grants, so they are two connections even for the same account. Google Docs (loopback PKCE client) and Drive backup (device-code client) therefore share one connection only when they are configured with the same client. With different clients each keeps its own connection, and neither forces the other to sign in again.

### 3. Business plugins never read credentials

A business plugin gets connection references and metadata (account label, scopes, status). Requests go through Host-injected credentials: `ctx.integrations.authenticatedRequest`, integration actions, or a base plugin's credential-free protocol helpers that call those. Only the plugin that provides the provider reads tokens, through `ctx.auth.getSession` on its own provider. `ctx.auth.onDidChangeSessions` delivers metadata only (ES-01, done).

### 4. Provider identity and the service contract

- A base plugin declares `providesServices: { "auth.<vendor>": "<exact version>" }` and registers its auth provider. A business plugin declares `requiresServices: { "auth.<vendor>": "^<major>" }` (or `optionalServices`). The existing resolver (`service-registry.ts`, `load-order.ts`) enforces presence, semver and cycles.
- Library modules (`ctx.libraries.importModule`) may export protocol helpers (request builders, response parsers, pagination). They never carry credentials, so importing one grants nothing.
- Each connection records its provider tuple (§2). When the owning plugin is disabled, the connection becomes `provider-unavailable` and keeps its credentials. When it is uninstalled, the Host attempts vendor revocation, tombstones the connection and deletes its credentials, even if revocation fails. Another plugin registering the same provider id cannot take it over: registration is refused while the ownership binding exists (b119bd3f9e), and a new owner after uninstall starts with new connections.

### 5. The Host coordinates refresh, rotation and logout

- The provider supplies `refresh(lineage)` and, where the vendor has one, `revoke(lineage)`. It does not decide when to call them.
- The Host auth registry runs one refresh per **token lineage** across windows with `navigator.locks` (the Logto precedent in `lib/logto/session-lock.ts`, with its IndexedDB fallback), and in headless with an in-process mutex plus the CLI's durable store.
- Every stored credential has a revision. A refresh result commits only if the revision it started from is still current (compare-and-swap). A rotated refresh token is stored in the same commit.
- Logout writes a revocation barrier (a tombstone revision) before calling `revoke`. A refresh that finishes later cannot commit over it, so logout is never undone.
- Built-in Rust providers (Google Docs today) keep their controllers and implement the same contract as **Host providers** (`pluginId: null`). Their nonce CAS and disconnect fence are the reference behaviour for the TS registry.

### 6. Callbacks are single-use and bound

- An authorization attempt records `{provider, client, issuer, state, codeVerifier, expiresAt}` in the Host. `state` is random, single-use and expires (10 minutes).
- A callback is accepted once, only for its own provider, client and issuer. Cancelling an attempt deletes the record, so a later callback is dropped. A replay or a callback for another client never creates a connection.
- A token exchange that needs a client secret (confidential client) runs only in a trusted environment: the desktop Rust host or an always-on Host (ADR-0224). The static-export frontend never holds a secret.

### 7. Auth methods

| Method | v1 | Runtimes |
| --- | --- | --- |
| OAuth authorization code + PKCE (`oauth-pkce`) | Yes | Desktop (Tauri) and Capacitor via the `cognia://auth/callback` deep link; browser via popup and `BroadcastChannel` where the vendor allows the redirect. Not headless: there is no interactive browser. |
| Confidential exchange: authorization code without PKCE (`oauth-confidential`), or PKCE against a token endpoint that needs a client secret | Through a trusted environment only (§6) | Desktop, the headless brain, an always-on Host, or a browser/mobile client whose paired gateway runs the exchange on its Host |
| Client credentials (`client-credentials`, bot or service principal) | Yes | Trusted environments only, as above |
| API key / personal access token (`api-key`) | Yes | All runtimes. Stored as Host connection credentials (the browser needs an unlocked vault). Never refreshed; a credential-injected request answered with 401 marks the connection `needs-reauth`. |
| Device authorization flow (`device-code`) | Host providers only | Google Drive backup through the Rust controller. Plugin providers: later; the Host refuses it with `device-code-deferred`, labelled inert in the UI. |
| Service account / signed JWT | Later | Trusted environments only |

The Host derives each method's availability per runtime from one matrix (`lib/external-services/runtime-support.ts`), with a stable reason and recovery actions, and enforces the same matrix (ES-33). A manifest's `runtimeCompatibility` may cite those reason ids. A client with only a paired gateway is judged per facet: exchange and network run on the Host, while secrets, callbacks and background sync stay local.

### 8. Upgrades and owner takeover

- **Base plugin upgrade (ES-15).** The manager refuses activation on a version conflict. An upgrade quiesces required consumers first (`quiesceServiceConsumers`), upgrades the provider, then restores each consumer to its previous enable intent. Dependency deletion protection stays for package `dependencies`. A `requiresServices` consumer does not pin its provider: uninstalling the provider stops the consumer, which keeps its enable intent, waits with the missing service recorded, and resumes on any compatible provider.
- **Owner takeover (ES-16).** Each exclusive duty has a lease: refresh (the lineage lock), sync (a per-connection cursor lease), and action jobs (the claim token and lease from bad783b824). A new owner takes over only after the lease expires. A non-idempotent write whose lease expired is marked `remoteOutcome: "unknown"` and never replayed. Acceptance needs fault-injection tests for all three.

### 9. Migration from built-in to plugin

- Built-in accounts move through `ctx.integrations.migrateLegacy`. Its completion marker and backup survive audit pruning, and rollback keeps rows edited after migration and reports them (ES-20/21).
- Every migration batch ships a table: old entry point → public interface → new plugin → data and reference migration → behaviour test → explicitly unsupported (ES-32). An old and a new implementation never own the same refresh, sync or write at the same time.

### 10. Data after disconnect, revocation or remote deletion

Online access and copies the user chose to keep are separate decisions:

| Data | Disconnect or revocation | Remote item deleted or access lost |
| --- | --- | --- |
| **In-flight reads** | Aborted where the Host owns the read (document providers, syncs). Every read carries the connection revision; a result that returns after the revision changed is dropped, including raw integration requests whose transport finishes. | Fails; the item is marked unavailable. |
| **Background sync, watches, webhooks** | Stopped and their cursors released (the sync lease ends). Nothing keeps using the old credentials. | The item is removed from the synced set at the next sync (tombstone). |
| **Derived data** (search index entries, RAG chunks and embeddings, link previews, cached metadata) | Removed for that connection. It was built from online access, so it does not outlive it. | Removed at the next sync. |
| **User-kept copies** (an attachment the user added to a message, a dock snapshot, a saved artifact, a quoted excerpt in history, a document imported into a Twin, an issue imported by Issue Sync) | Kept, including what is built from the local copy (a Twin's chunks and embeddings). Refresh, re-sync and publishing from them are refused while the source is disconnected. Each carries provenance: provider, connection, remote id and the time it was captured. It shows "source disconnected" and cannot be refreshed or reopened live until a connection to the same account is restored. | Kept, marked "source deleted or no longer accessible". |

Reconnecting the same account (same connection identity, §2) restores live reopen for kept copies; derived data is rebuilt by the next sync, not restored. Purging a plugin's data (uninstall with "also wipe stored data") removes its derived data; user-kept copies are the user's and are removed only by the user. A business plugin's consumer grant being revoked stops its reads and syncs the same way, without touching other consumers of the same connection.

## Considered options

- **Consented token reads for business plugins.** Simpler for plugin authors, but every consumer becomes a credential holder, and revoking one consumer cannot be enforced. Rejected.
- **A generic Rust auth controller.** The most robust on desktop, but unusable in the browser and on mobile. Kept only for existing built-in providers.
- **Each base plugin coordinates its own refresh.** Cannot coordinate across windows or across old and new implementations during an upgrade. Rejected.
- **Library modules exporting a credential-bound client.** Convenient, but credentials enter the consumer's context. Rejected in favour of credential-free helpers.
- **One connection per purpose.** Strongest isolation, but repeated sign-ins for the same account. Kept as a user choice, not the default.

## Consequences

- A business plugin cannot outgrow its consumer grant, and revoking one consumer leaves others intact.
- Two accounts, clients or tenants of one vendor coexist; consumers bind explicitly.
- Base plugins get simpler: no refresh scheduling, no callback bookkeeping.
- The external-services view keys connections by connection id, not by `(plugin, service, provider)`, so multiple accounts show separately (ES-29).
- Plugin authors must declare services and request consumer grants. Existing integrations keep working as their own consumers until migrated.

## Rollout

1. **Contract types.** Connection tuple and reference, connection revision, `CapabilityGrant.consumerPluginId` and `connectionRevision`, provider tuple on connections. Plugin-contract catalog and mirrors.
2. **Host coordination.** Lineage lock, revision CAS and revocation barrier in the auth registry; attempt records and single-use callback acceptance; headless store.
3. **Consumer grants.** Authorization checks, selection and binding UI, grant prompts, connection-keyed external-services view, and the §10 rules: revision-checked reads, sync stop on disconnect, derived-data purge, provenance on kept copies.
4. **Feishu vertical.** `feishu-auth` as the first base plugin (PKCE desktop, tenant and bot principals), one business plugin (calendar) as consumer, with the ES-32 behaviour table.
5. **Google as a Host provider.** The Rust controller exposed through the same contract; Docs and backup as two consumers of the Google provider, sharing a connection when they use the same OAuth client (§2).
6. **Batch extraction** of further capabilities, each with its behaviour table and rollback evidence.

Before acceptance only `feishu-auth` and, by an exception accepted on 2026-10-31, `feishu-calendar` (c94a6623c4) were extracted. Both now run on this contract (step 4). Further extraction follows step 6.

## Implementation status

Steps 1–5 and the ledger items they carry (ES-07–12, 15, 16, 23–34, 36) are implemented; ES-05 has its own transition (790409b15e). Step 6 has not started.

| Step | Commits | Notes |
| --- | --- | --- |
| Prerequisites | b119bd3f9e, cd624cccf9, cb9ac351a0, bad783b824, 52f21fa704, 5ee04bcdb8, 838096514f, 3e421eabfa, 5843a0036b | ES-01–06, 13, 14, 18–22 |
| 1. Contract types | 88839f2109, 88190841f5, 35e9d6dc2c | |
| 2. Host coordination | 72bfdc2904, af4e830f88, aa04caf227 | Lineage lock, revision CAS, revocation barrier, single-use callbacks, `auth:exchange` through `cognia-net`. The CLI keeps credentials in a `0600` file store with an `O_EXCL` lock, like `logto.json`, not in the encrypted snapshot. |
| 3. Consumer grants and §10 | 68d70d0e14, c3d348ce20, ea7cd32c2e, 23f4f7daf3, 45d7a34d65, 39b1708d70, e022cd293f | Grants are checked at credential injection, reads included. Device-local provenance and "source …" states for kept copies, including Twin and Issue Sync imports; the GitHub issue mirror is purged as derived data. |
| §8 upgrades and takeover | 43f59e2191 | Upgrade quiesce, per-connection sync leases, fault-injection tests for the three leases |
| Domain contributions (ES-24–28) | c74a78f73a, fb1baf0a1f, 19db335e88, 781eb66849, 4ab64c0282 | `ctx.docsProviders`, Issue Sync providers, `ctx.backup.registerDestination`, Host-managed auth providers, example plugins with no Host imports |
| 4. Feishu vertical | fb84bc93ac, 81cce06da3, f63804eead, ed802d1c66, f5db767198, 7f75f7f62b, 889154ac2b | Built-in Lark is a Host provider; `feishu-auth` provides `auth.feishu` (user PKCE, bot client credentials); `feishu-calendar` consumes it through grants. The plugin PII-gate exemption for Feishu refresh is removed. |
| 5. Google | c5d07a460b, 3d005f801b, 282f37bedb | The Rust controller owns exchange, refresh and revoke with Host-held per-client secrets. Docs and Drive backup consume `auth.google`. |
| Incremental sync (ES-31) | 2aa72591dc, d2799a1822, b38620883c, 9406caedfb | Shared core with per-page commits and tombstones; Issue Sync and the GitHub mirror on it; public `ctx.sync`; `feishu-calendar` on Host cursors |
| Runtime and release (ES-33, 34) | 07af5f3535, 409e2886ec | Runtime support matrix with per-cell evidence tests; Feishu release matrix through the real manager |

Behaviour tables (ES-32): `plugins/feishu-calendar/README.md` and `docs/evidence/2026-11-02-adr-0246-es32-builtin-migrations.md`.

Known limits:

- `ctx.auth.getSession` by a non-owner still returns the token with an audit entry (`DEFAULT_CONSUMER_TOKEN_READ_POLICY = "allow-with-audit"`). The next release flips it to `deny`.
- Plugin `device-code` is dormant (§7).
- Sync subscription renewal (`external-sync-renewal`) is dormant; `feishu-calendar` polls.
- Node-target plugins register `ctx.sync` drivers only at activation.
- Background sync runs only where the integration runtime runs (desktop, headless brain).
- A real-account smoke test (Feishu user and bot, calendar sync, built-in Lark sharing the connection, Google Docs, Drive backup, disconnect purge) has not been run yet.
