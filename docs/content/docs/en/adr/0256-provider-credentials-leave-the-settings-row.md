---
title: "0256 — Provider credentials leave the settings row"
description: "Every credential a provider row carries is split off at the settings persistence boundary and kept in a per-database secret blob in the platform secret store (the OS keyring store on the desktop, Keychain/Keystore on the phone, the Browser Vault or a device-wrapped IndexedDB store on the web, the service store on a headless Host). The persisted settings row keeps only a pointer and a revision. Reads join the blob back, so every synchronous consumer still sees a complete provider row in memory."
---

# ADR 0256 — Provider credentials leave the settings row

**Status:** Accepted
**Date:** 2026-11-15

**Related:**
- [ADR-0215](./0215-one-person-one-encrypted-sync-space-many-writable-hosts) §7: "BYOK keys first move out of the plaintext `settings` row". This ADR is that step. Secret sync across devices stays out of scope.
- [ADR-0067](./0067-src-tauri-crate-decomposition-and-build-speed): the `cognia-secrets` crate behind the desktop `secret_store_*` commands this ADR writes through.
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings): Host sealed provider keys (`lib/host-secrets/`). They are a separate source and are unchanged.

**Evidence:** audit `docs/evidence/2026-11-14-provider-configuration-mode-audit.md`, finding F2. Commit 45b57790de made verification fingerprints credential-free (contract v3) and added the schema-aware projection `packages/provider-types/src/provider-secrets.ts`.

## Context

`saveSettings` (`lib/db/settings.ts`) writes the whole `AppSettings` singleton into the Dexie `settings` table. That row holds every provider credential in plaintext:

- `providerSettings[*]` and `customProviders[*]`: `apiKey`, the `apiKeys` pool, `apiKeyUsageStats` (keyed by the raw key), `oauthRefreshToken`, credential-bearing `customHeaders`, Bedrock `apiKey` / `accessKeyId` / `secretAccessKey` / `sessionToken`, OpenRouter `provisioningApiKey` and `byokKeys`, the CLIProxyAPI `managementKey`, and credential-looking keys in `providerSpecificParams` / `advancedParams`;
- the legacy top-level `apiKey`.

The table is classified `metadata-only`, so the account content-encryption middleware never encrypts it. Many consumers read keys synchronously from the in-memory settings (`createProviderSettingsSnapshot`, `resolveFeatureProvider`, `getActiveCredential`), so moving keys behind an async lookup at each use is not possible without rewriting every caller.

Constraints that shaped the decision:

- **Three shells plus a headless Host.** The web has no OS keyring and may run without an unlocked Browser Vault. The existing `BrowserVaultStore` falls back to process memory, which would drop keys on every reload.
- **The settings database is per account and per runtime target.** Two databases must never share keys by accident, and migrations copy a database's rows to a new database name and then delete the source.
- **Overlay windows** (pet, selection toolbar, tray panel, chat copilot and others) cannot call `secret_store_*`. None of them reads provider credentials.
- **Several raw writers** read the row and put it back with one field changed (pet packs, twin redaction key, subscription lifecycle, account-sync applier, backup restore).

## Decision

### 1. Split at the persistence boundary, join on read

`getSettings` and `saveSettings` are the only code that knows credentials are stored apart. The in-memory `AppSettings` returned by `getSettings` is complete, as before, so the settings store and every synchronous consumer are unchanged.

- `splitProviderSecrets` / `joinProviderSecrets` (`packages/provider-types/src/provider-secrets.ts`) split one provider row into a public row and a sparse secret record, using the same field inventory `stripProviderSecrets` uses. `stripProviderSecrets` is rebuilt on top of the split, so a new credential field is added in one place for exports and for persistence. A join after a split returns the original row.
- `lib/settings/provider-secret-split.ts` applies that per row to the settings singleton (built-in map, custom list, top-level `apiKey`). It upgrades a v2 verification fingerprint first, because a v2 fingerprint embeds the raw key and can only be rewritten while the key is present.
- Verification status, the v3 fingerprint and `currentKeyIndex` are not secrets and stay in the row.

### 2. One secret blob per settings database

`lib/settings/provider-secret-store.ts` keeps one JSON blob per Dexie database name, namespace `cognia-provider-secrets`, entry key = the database name. The blob holds `{ v: 1, db, rev, apiKey?, providerSettings, customProviders }`.

| Shell | Backend |
| ----- | ------- |
| Tauri desktop (main window) | `createLocalKeyringStore`: the `secret_store_*` commands of this process, never the remote-routed transport |
| Headless Host | `createKeyringStore`: the service-scoped secret store over companion RPC |
| Capacitor phone | `createKeyringStore`: iOS Keychain / Android Keystore |
| Web | `lib/settings/web-provider-secret-store.ts`: the account Browser Vault while one is unlocked; otherwise AES-GCM ciphertext in the `cognia-provider-secrets` IndexedDB database under a non-extractable device key (the device-pepper pattern of quick unlock). A value written while locked is promoted into the vault on the next read with the vault unlocked. |

The web device-wrapped store protects against exported or copied data at rest. It does not protect against code running as the user in the page, which can use the key in place. This is the same claim quick unlock makes, and it is stronger than today's plaintext row.

### 3. The row keeps a pointer and a revision

The persisted row carries `providerSecretsRef: { db, rev }`. It is not part of `AppSettings`: `getSettings` removes it, no export carries it, account sync never sees it (not a `shared` key) and the companion projection is an allow-list.

- **Revision.** Every blob write gets a new random `rev` and the row records it. A process caches the blob per database and trusts the cache only while the row's `rev` matches, so another tab or window that changed keys is picked up on the next read and a stale cache never writes back old keys.
- **No pointer, no blob.** A row without a pointer has no credentials in the store, so a database deleted and created again under the same name never sees a blob left behind.
- **Copies.** A database migration copies the row, pointer included, under a new name. On first read the target resolves the pointer: when the blob under its own name does not match the revision and the blob under `ref.db` does, it uses that blob and adopts it into its own entry at the next persist, deleting the source entry once the source database no longer exists. The revision check stops a row that arrived from another device from picking an unrelated blob.

### 4. Writes are write-ahead, and refuse rather than lose

`saveSettings` computes the merged row, splits it, and:

1. writes the blob first when the secret record changed (no write when it is unchanged, so ordinary saves cost no secret-store call), then
2. puts the public row with the new pointer.

If the secret store cannot be read or written, a save that changes credentials fails with `ProviderSecretStoreUnavailableError` and nothing is written. A save that does not change credentials still succeeds, including when the store refuses the write that would have moved legacy plaintext; the row then keeps exactly what it had (that plaintext and its existing pointer). Overlay windows hit this path only for saves that do not touch credentials.

### 5. Migration of existing rows

A row that still holds plaintext credentials is migrated by the next persist on any shell. `getSettings` notices plaintext in the row and queues one migration per database and process through the same save queue; the migration re-reads the raw row and does nothing if another writer already cleaned it. Plaintext in the row wins over the blob for the fields it carries, because only an older build or a raw writer puts it there. When the secret store is unavailable the plaintext stays until a later attempt succeeds.

### 6. Exports, backups and restore

- Both backup builders read through `getSettings`, so "Include API keys" keeps exporting the keys and the default export keeps stripping them.
- Restore (`lib/data/apply-package.ts`) writes only the public row inside its transaction. With "Include API keys", the backup's secret record is merged into this database's blob before the transaction, the backup winning per provider. Without it, this device's keys stay with the providers that still exist.
- The provider import/export dialog and profile transfer read the in-memory settings and are unchanged.

### 7. Deletion

Deleting an account's databases, its runtime targets, a removed Host's target databases, clearing the settings table and Clear all data also delete those databases' blobs.

## Consequences

- No provider credential is written to the persisted `settings` row on any shell once the secret store is available; the gate is a raw IndexedDB read in tests.
- A key rotation that records usage (`apiKeyUsageStats`) now writes the secret blob on each turn that uses a pooled key. Re-keying the stats by digest would avoid it and was rejected for now: it adds a second persisted derivative of the key for a feature that is off by default.
- Web on an insecure origin (no WebCrypto) cannot store provider credentials; saving one reports the store as unavailable instead of keeping it in plaintext.
- Other secrets in the settings row (search provider keys, TTS and live-voice keys, network proxy password on the web) are not covered here. They can reuse the same split-and-blob mechanism with their own inventory.

## Glossary

- **Secret blob**: the per-database record of every provider credential, stored in the platform secret store.
- **Secret record**: the sparse, credential-only half of one provider row produced by `splitProviderSecrets`.
- **Pointer** (`providerSecretsRef`): the `{ db, rev }` pair in the persisted row that names which database's blob holds its credentials and which revision it expects.
