---
title: "0246 — A business plugin reaches a service through a granted connection"
description: "A base plugin (Feishu, Google, …) adapts one vendor's sign-in and protocol and provides an auth service. Business plugins (calendar, docs, tasks, backup) declare that service, get an opaque connection reference, and act through Host-injected credentials under their own consumer grant. The Host owns the connection's identity, refresh, rotation, logout and callbacks; built-in Rust providers implement the same contract."
---

# ADR 0246 — A business plugin reaches a service through a granted connection

**Status:** Proposed
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
| **Consumer grant** | The Host, per business plugin | Which operations and scopes one business plugin may use through one connection, at one connection revision. |

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

**Purposes share a connection.** One remote grant backs one connection. Different purposes (Google Docs read vs Drive backup) are different consumer grants on it. A user may still create a separate connection for a purpose, and bind a consumer to it.

### 3. Business plugins never read credentials

A business plugin gets connection references and metadata (account label, scopes, status). Requests go through Host-injected credentials: `ctx.integrations.authenticatedRequest`, integration actions, or a base plugin's credential-free protocol helpers that call those. Only the plugin that provides the provider reads tokens, through `ctx.auth.getSession` on its own provider. `ctx.auth.onDidChangeSessions` delivers metadata only (ES-01, done).

### 4. Provider identity and the service contract

- A base plugin declares `providesServices: { "auth.<vendor>": "<exact version>" }` and registers its auth provider. A business plugin declares `requiresServices: { "auth.<vendor>": "^<major>" }` (or `optionalServices`). The existing resolver (`service-registry.ts`, `load-order.ts`) enforces presence, semver and cycles.
- Library modules (`ctx.libraries.importModule`) may export protocol helpers (request builders, response parsers, pagination). They never carry credentials, so importing one grants nothing.
- Each connection records its provider tuple (§2). When the owning plugin is disabled, uninstalled or replaced, the connection becomes `provider-unavailable`. Another plugin registering the same provider id cannot take it over: registration is refused while the ownership binding exists (b119bd3f9e), and a new owner after uninstall starts with new connections.

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
| OAuth authorization code + PKCE (public client) | Yes | Desktop (Tauri) via `cognia://` deep link; browser via popup and `BroadcastChannel` where the vendor allows the redirect |
| API key / personal access token | Yes | All runtimes; stored in the Host secret store |
| Confidential-client exchange | Through a trusted environment only (§6) | Desktop, always-on Host |
| Device authorization flow | Later | — |
| Service account / signed JWT | Later | Trusted environments only |

Each base plugin declares the methods and runtimes it supports in its manifest `runtimeCompatibility`, with a machine-readable reason for each blocked runtime (ES-33).

### 8. Upgrades and owner takeover

- **Base plugin upgrade (ES-15).** The manager refuses activation on a version conflict. An upgrade quiesces required consumers first (`quiesceServiceConsumers`), upgrades the provider, then restores each consumer to its previous enable intent. Dependency deletion protection stays.
- **Owner takeover (ES-16).** Each exclusive duty has a lease: refresh (the lineage lock), sync (a per-connection cursor lease), and action jobs (the claim token and lease from bad783b824). A new owner takes over only after the lease expires. A non-idempotent write whose lease expired is marked `remoteOutcome: "unknown"` and never replayed. Acceptance needs fault-injection tests for all three.

### 9. Migration from built-in to plugin

- Built-in accounts move through `ctx.integrations.migrateLegacy`. Its completion marker and backup survive audit pruning, and rollback keeps rows edited after migration and reports them (ES-20/21).
- Every migration batch ships a table: old entry point → public interface → new plugin → data and reference migration → behaviour test → explicitly unsupported (ES-32). An old and a new implementation never own the same refresh, sync or write at the same time.

### 10. Data after disconnect, revocation or remote deletion

Online access and copies the user chose to keep are separate decisions:

| Data | Disconnect or revocation | Remote item deleted or access lost |
| --- | --- | --- |
| **In-flight reads** | Aborted. Every read carries the connection revision; a result that returns after the revision changed is dropped. | Fails; the item is marked unavailable. |
| **Background sync, watches, webhooks** | Stopped and their cursors released (the sync lease ends). Nothing keeps using the old credentials. | The item is removed from the synced set at the next sync (tombstone). |
| **Derived data** (search index entries, RAG chunks and embeddings, link previews, cached metadata) | Removed for that connection. It was built from online access, so it does not outlive it. | Removed at the next sync. |
| **User-kept copies** (an attachment the user added to a message, a dock snapshot, a saved artifact, a quoted excerpt in history) | Kept. Each carries provenance: provider, connection, remote id and the time it was captured. It shows "source disconnected" and cannot be refreshed or reopened live until a connection to the same account is restored. | Kept, marked "source deleted or no longer accessible". |

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
5. **Google as a Host provider.** The Rust controller exposed through the same contract; Docs and backup as two consumers of one connection.
6. **Batch extraction** of further capabilities, each with its behaviour table and rollback evidence.

Until this ADR is accepted, no capability other than `feishu-auth` is extracted into a plugin.

## Implementation status

Not started. Prerequisite fixes from the review are in: b119bd3f9e and cd624cccf9 (ES-01/02/03/04/09), cb9ac351a0 (ES-06), bad783b824 (ES-13/14), 52f21fa704 (ES-18–21), 5ee04bcdb8 (ES-22), and 838096514f (fixes from a review of those commits). §10 was added on 2026-10-31 for ES-23, which the first triage missed.
