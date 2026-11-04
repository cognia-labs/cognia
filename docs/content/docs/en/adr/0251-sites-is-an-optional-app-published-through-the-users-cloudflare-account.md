---
title: "0251 — Sites is an optional app published through the user's Cloudflare account"
description: "Sites publishes a project the user already has to the user's own Cloudflare account, with immutable versions and recoverable operations. It is an optional application, a module today and a plugin candidate under ADR-0250 §14. It owns no Rust code and no settings keys, but it owns nine core tables, and five outside files import its status vocabulary. Cloudflare is the only provider, the credential never leaves the host's keyring, and an uncertain provider outcome is reconciled, not retried. Sites meets none of §9's three extraction conditions yet. This ADR lists what has to change first and leaves the tables' fate to the extraction itself."
---

# ADR 0251 — Sites is an optional app published through the user's Cloudflare account

**Status:** Proposed
**Date:** 2026-11-05

**Related:**
- [ADR-0084](./0084-cognia-sites): the Sites lifecycle, persistence, confinement and visitor access. This ADR does not change any of it.
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds): §9 (extraction rule) and §14 (classes, manifests, gates)
- [ADR-0246](./0246-a-business-plugin-reaches-a-service-through-a-granted-connection): granted connections, the model for a credential a plugin may use
- [ADR-0059](./0059-cloud-deployment-headless-brain): the headless brain, which has no keyring yet

**Evidence:** `docs/research/feature-module-analysis-2026-11-04.md` (§11.2 decides that Sites may become a plugin later and asks for this ADR). The counts below were taken from the tree on 2026-11-05.

## Context

ADR-0084 defines how a Site is built, versioned, deployed and recovered. It does not say where Sites sits among Cognia's subsystems, what else may depend on it, how much of it is really Cloudflare, or whether it can leave the app. ADR-0250 §14 now needs those answers: it classes Sites as an optional application, and §9 lets a module become a plugin only when three conditions hold.

Sites is about 12.9k lines in 58 files. Most of it is a console UI over a durable operation state machine. Its provider code is one directory.

## Decision

### 1. What Sites is for, and what it is not

Sites publishes a project the user already has, from the user's own workspace, to the user's own Cloudflare account. It keeps immutable saved versions, rolls back by deploying an older version, and manages environment values, resources, visitor access, domains, logs and takedown for the result.

It is not:
- **A hosting service.** Cognia runs no infrastructure for Sites. The deployed site, its data and its bill belong to the user's Cloudflare account. If Cognia is closed, the site keeps serving.
- **A site builder.** Source, editing, Git, terminal, browser preview and artifacts belong to the project, editor, source-control, terminal and browser subsystems, which Sites calls (ADR-0084).
- **Share links, the docs site or the marketing site.** Share links are ADR-0037's service. The docs site is `docs/`. The marketing site is its own repository.
- **Server operations.** Deploying Cognia's own services to a machine the user owns is the Ops Controller (ADR-0059). Sites deploys the user's projects.
- **A multi-provider abstraction.** See section 3.
- **An unattended publisher.** Takedown and purge are console-only, and workflow nodes cannot reach them (`lib/workflow/nodes/sites/index.ts`).

### 2. Boundary

**Sites owns.**

| Kind | What |
| --- | --- |
| Code | `lib/sites/` (including `lib/sites/cloudflare/`), `components/sites/`, `hooks/sites/`, `stores/sites/`, `app/sites/`, `lib/db/sites.ts` |
| Types | `SiteProjectRow` and the other row types, defined in `packages/plugin-contract/src/types/sites.ts` and re-exported by `types/sites.ts` |
| Strings | `i18n/messages/{en,zh-CN}/sites.json` |
| Route | `/sites`, declared in `lib/runtime/surface-contract.ts`, the sidebar contract and `lib/shell/full-viewport-routes.ts`. Standalone `full`, companion `remote` |
| Tables | Nine: `siteProjects`, `siteVersions`, `siteArtifacts`, `siteEnvironmentRevisions`, `siteDeployments`, `siteOperations`, `siteOperationEvents`, `siteResources`, `siteBuildLogs`. All are in `CURRENT_SCHEMA` and in `CORE_TABLE_NAMES`; retention for three is in `lib/data-governance/table-catalog.ts` |
| Credentials | One OS-keyring entry per Site under the service `cognia-sites`, plus `providerTokenState` on `siteProjects` so the UI can ask whether a token exists without reading it. One ledger id, `builtin:cognia-sites`, in the shared approved-binaries table for the wrangler binary |
| Registrations | Workflow nodes `action.site.{build,deploy,rollback,status}` with their inspector forms, the `builtin.sites` global-search provider, the read-only plugin API `ctx.sites`, `SitesInitializer` (recovery and notifications on account unlock), the artifact sweep in `lib/storage/retention.ts` |
| Settings keys | None. Sites reads no `AppSettings` key |
| Rust and host commands | None of its own. It calls generic commands: `sandbox_exec`, `git_log`, `git_status`, `detect_binary` and `detect_binary_invalidate` |

**Sites depends on.** The database instance, the account store (the actor identity for the authoring policy), projects and workspaces, the credential keyring, the sandbox policy bridge, the proxy-aware fetch, file operations, the terminal spawn orchestrator and store (preview), the embedded browser, notifications, the workflow engine, global search, and data governance. All of these are kernel or foundation, so the direction rule holds for everything Sites imports.

**What imports Sites.** Two groups:
- **Registrations**, which are the contribution points ADR-0250 §14 turns into manifest fields: the workflow catalog, global search, retention, the plugin API, the initializer, the schema and the table catalog.
- **A shared vocabulary.** Five files outside Sites import `SiteTone` and the tone classes from `components/sites/site-status`: `components/desktop/status-bar-connectivity.tsx`, `components/devices/execution-host-switcher.tsx`, `components/devices/host-controls.tsx`, `components/settings/connectivity/panels/overview-panel.tsx` and `.../remote-hosts-panel.tsx`. They use it to colour connectivity state. That is a foundation concern in the wrong place, and it is the only real inbound dependency.

### 3. The dependency on Cloudflare

**Cloudflare is the only provider, and the code says so honestly.** `SiteProvider` is the single value `"cloudflare"`. ADR-0084 puts provider behaviour "behind a Sites-specific hosting boundary", but that boundary is a directory, not an interface: hooks, boot, workflow nodes and the build and publish steps call `CloudflareSitesService` directly. This ADR does not add a provider interface. One would be designed against a single implementation and would guess wrong. It is added together with the second provider, and the manifest, build, artifact and visitor-policy code stays free of Cloudflare imports so that the interface has something to separate.

**How Sites reaches Cloudflare.**
- **Upload.** `wrangler` runs in the OS sandbox with network limited to `api.cloudflare.com`. The token is its environment, and it exists only in that upload process. The build itself never sees a credential (ADR-0084).
- **Everything else.** D1, R2, secrets, domains, Access applications and policies, logs and analytics use `https://api.cloudflare.com/client/v4` and its GraphQL endpoint, through the app's proxy-aware fetch.
- **Credential.** The user supplies an API token per Site. Sites verifies it against `/user/tokens/verify`, stores it in the local keyring and never returns it. It stays in the host's keyring and is used only when the Site's execution target is the local host. The keyring cannot be enumerated, so `providerTokenState` records `verified` or `rejected`.
- **Wrangler.** It must be found on the host. Sites approves its exact bytes in the ledger, and a missing or changed binary fails the upload closed.

**Failure modes, and what each does.**

| Failure | Result |
| --- | --- |
| No token on this host, or Cloudflare rejects it | The operation is refused with a named error. `providerTokenState` becomes `rejected` |
| Timeout, 429, 5xx or a network error on a mutating call | The outcome is uncertain. The operation is marked for reconciliation and never retried blind (`mutationOutcomeIsUncertain`). A later reconcile reads provider state and resolves it |
| The app dies mid-operation | The lease expires. `bootSites` resumes every owned Site's operations at the next unlock |
| Cloudflare unreachable | Builds, previews and the console, which reads the local database, keep working. Provider actions fail. The deployed site is unaffected |
| An Access policy changed outside Cognia | Drift is detected. A restricted Site fails closed (ADR-0084) |
| A shared or adopted resource | Purge leaves it alone (ADR-0084) |
| Off the desktop | Each privileged action is disabled with a stated reason. A headless brain cannot recover Sites, because `createLocalKeyringStore` throws off Tauri (`scripts/gates/headless-registry-exclusions.json`, phase 2). That is debt behind a credentials decision, not a Sites decision |

Cognia's other uses of Cloudflare (the companion tunnel guide, TURN credentials) are separate and share no code with Sites.

### 4. The path to a plugin

ADR-0250 §9 lets a module move out as a plugin only when all three conditions hold, and a module that needs Rust windows or host commands of its own stays a module. Sites today:

| Condition | State | What blocks it |
| --- | --- | --- |
| Rust or host commands of its own | **Met.** There are none | Nothing. The generic commands it calls must stay reachable through the plugin contract |
| Every host dependency is within the plugin contract surface | **Not met, partly unchecked** | The contract has sandbox, secrets, git, terminal, browser, notification, database and workflow-author surfaces. Not checked: whether the sandbox surface expresses Sites' per-call mounts, CPU and memory bounds and host allowlist. Missing: an actor identity (a plugin has no account, so `assertSiteAuthoringCapability` cannot run for it, as `lib/plugin/api/sites.ts` records), a permission meaning "may publish a website" (today `ctx.sites` is read-only under `database:read`). Also not checked: whether a plugin can reach the approved-binary ledger |
| No other module imports it | **Not met** | The five connectivity files above. Moving `SiteTone` into a foundation status vocabulary closes it. The registrations are not imports once they are manifest contributions |
| Its tables are settled | **Not met** | Sites owns nine tables in the core schema. A plugin's tables are namespaced `${pluginId}:${tableName}`, so extraction renames them, which is a data migration |

**Does Sites own core tables?** Yes: nine, all in `CURRENT_SCHEMA` and `CORE_TABLE_NAMES`, with `siteProjects.projectId` pointing at core projects. They are owned by Sites alone: no other subsystem reads or writes them except through the registrations above, and `ctx.sites` is a redacted read-only projection.

**What is decided now.**
1. Sites is an optional application, and a module until the three conditions hold. It is not extracted in this phase.
2. The `SiteTone` vocabulary moves to the foundation the next time any of its five importers is touched. After that, a new import of `components/sites/` or `lib/sites/` from outside Sites is a G2 or G3 violation.
3. When the module track reaches Sites, its manifest declares the route, the nine tables, the workflow nodes, the search provider, the retention executor and the initializer as contributions, with `settings.keys` empty.
4. Cloudflare names stay inside `lib/sites/cloudflare/`, the console's provider-specific tabs and the types that mirror Cloudflare objects.
5. The plugin contract gets a Sites permission and an actor identity for a plugin only when extraction is scheduled, not before. Minting a permission edits the catalog and regenerates five artifacts, so it is its own decision.

**What is not decided here.** The fate of the nine tables at extraction. The options are ADR-0250 §9's three: drop the data, migrate it, or keep the core tables and grant the plugin access. Dropping would orphan managed Cloudflare resources and lose rollback history unless a purge runs first, so it is the least likely. The choice depends on what the contract can grant, and it gets made when extraction is scheduled.

## Consequences

- Sites stays in the app for now, and nothing about the user's sites changes.
- The one cheap fix, moving the tone vocabulary, removes the only inbound dependency and is worth doing whatever happens to extraction.
- A second provider, a headless Sites host and a plugin Sites all need a decision that is deliberately deferred here: a provider interface, a headless keyring, and a publish permission with an actor identity. Each has a named trigger, so none is built speculatively.
