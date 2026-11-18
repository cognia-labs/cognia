# CLI sign-in per local account (audit items 06 + 07)

Status: built 2026-11-18 (ADR-0149, "The CLI: one sign-in per local account").
While building, the `validateRegistrationContext` check turned out to refuse the
native client for every caller, so the app's own native OIDC pairing
(`components/connectivity/pair/pair-api.ts`, which signs in as
`nativeClientId`) was broken the same way; widening it fixed both.
Source: `docs/evidence/2026-10-28-cli-api-wrapper-gap-audit.md` items 06 and 07.
Related: ADR-0149 §9 (a LocalProfile binds to a person on first login),
ADR-0215 (one person, one sync space), ADR-0059 (headless Brain).

## Problem

The CLI keeps one Logto session per `COGNIA_HOME` (`<home>/logto.json`).
Everything that acts for a person reads that one file:

| Reader | Where | What it needs |
| --- | --- | --- |
| Account sync (Brain + `account-sync`) | `cli/src/account-sync/headless-sync.ts:72` | a session of the official issuer |
| Collaboration reader (Brain) | `cli/src/serve/collab-reader.ts:116` | a session of the org's own Logto |
| `logto status` / `logout` | `cli/src/cli/logto-command.ts` | the one file |

Four consequences:

1. **Two Hosts on one machine share one person.** Each Host passes its own
   `COGNIA_LOCAL_ACCOUNT_ID` to its Brain (`crates/cognia-server/src/brain.rs:175`),
   but both Brains read the same `logto.json`. Signing one in as B switches the other
   to B. Items 01 and 05 were the symptoms of this. Their fixes catch it after the
   switch has already happened: the `other-account` join question, and the
   collaboration reader's subject check.
2. **One `--account` picks the data, but not the person.** `serve --account` and
   `account-sync --account` name a partition, yet the person always comes from the
   shared file (item 07).
3. **Nothing records which person a partition belongs to.** The desktop binds a
   LocalProfile to a person on first login and refuses anyone else unless asked
   to rebind (`lib/identity/user-binding.ts`). The CLI has no such record.
   The Brain's registry binding is made fresh at every start, from whoever
   happens to be in the file.
4. **A multi-tenant Host cannot be paired from the CLI.** `host login` tells the
   user to run `logto login` and then `host add --kind device --tenant <id>`
   (`cli/src/host/login.ts:68`, `cli/src/host/pair-invitation.ts:75`). But
   `host add` writes a record with no device identity and never reads the
   session. `registerCompanionDevice` already supports `mode: "oidc"`
   (`lib/tauri/companion-auth.ts:233`); the CLI never calls it that way.

## Decisions

| # | Decision | Rejected alternative |
| --- | --- | --- |
| D1 | **A sign-in belongs to a local account**, as it does on the desktop (`lib/logto/session-store.ts`: "one session per LocalProfile"). `--account` picks the partition and the person together. Several people means several accounts. | Named slots plus an active pointer (`gh auth switch` style). That keeps two selectors, which is item 07. |
| D2 | **An account binds to a person on its first sign-in.** A sign-in as anyone else is refused, and the message names both people. `--rebind` is the explicit takeover. `logout` removes the tokens and keeps the binding. | Replacing on every login, relying on the join question and the reader checks after the fact. |
| D3 | **No persistent "current account".** The account is `--account`, else `COGNIA_LOCAL_ACCOUNT_ID`, else `local_acct_a`, for every command. A restarted Brain never quietly opens another partition. | `logto use` writing a default into `COGNIA_HOME`. |
| D4 | **Multi-tenant Host pairing is in scope.** `host login` uses the account's session to register the device. | A separate task. |

A local account signs in to **one deployment**, because the issuer is part of the
bound person. This matches the desktop, where a profile signed in to a
self-hosted deployment has no account sync (`lib/account-sync/sync-session.ts:5`).
To have both an official-account Host and an org Host, run two accounts.

## Model

```
<COGNIA_HOME>/accounts/<id>/      id = encodeURIComponent(account); "", ".", ".." refused
  logto.json                      the session (0600): tokens, issuer, resource, org
  logto-login.json                the sign-in in flight (attempt marker)
  person.json                     the bound person (0600), kept across logout:
                                  { issuer, subject, userId?, orgId?, displayName?,
                                    email?, boundAt }
```

- The per-home lock `logto-session` becomes one lock per account
  (`createCliFileLock(home)("logto-session:<id>", …, "lineage")`). Writes,
  refreshes, binding checks and the attempt marker for one account are serialized
  together, and a login for account Y no longer supersedes one in flight for X.
- `<home>/logto.json` is no longer read. Local data is not migrated, so every
  existing install signs in again once. The changeset and docs say so and tell the
  user to delete the old file.
- The account-sync keyring stays in `<home>/account-sync/`. Its keys are already
  scoped `localAccountId:spaceId:name` (`lib/account-sync/vault-store.ts:96`).
- Collaboration cursors stay in `<home>/collab-notifications/<id>.json`, which is
  already per account.

### The one account resolver

New `cli/src/config/local-account.ts`:

- `resolveLocalAccount(args, env)` returns `{ id, source: "flag" | "env" | "default" }`.
- `accountDir(home, id)` validates and encodes the id.

`serve`, `account-sync`, `logto` and `host login` all call it. It replaces the copies
in `serve-command.ts:145` and `account-sync-command.ts:141`.

### `cli/src/config/logto-session.ts`

Every export takes `(home, account)` instead of `home`.

New:

- `readBoundPerson(home, account)`.
- `bindOnLogin(home, account, session, { rebind })`, run inside the account lock
  together with `completeLogtoLogin`. It returns `"bound" | "same" | "rebound"`,
  or a `mismatch` error carrying both people.

A person is the pair (issuer, `sub`). The `usr_` id and the display fields are
kept only for messages and for the Brain's registry row.

## Commands

### `logto login [--account X] [--rebind] [existing flags]`

1. The sign-in runs as today, with the attempt marker per account.
2. Under the lock, compare the new session to `person.json`:
   - **no binding**: write it and save the session;
   - **same person**: save the session;
   - **different person, without `--rebind`**: revoke the new tokens, keep the
     old session untouched, and exit 1. The message names both people and the
     way out. Example:
     `account X acts for Ann <ann@…> (usr_…) at https://id.cognia.cn; this sign-in was Bob <…>.
     Sign in as Ann, or pass --rebind to make account X act for Bob from now on.`
   - **different person, with `--rebind`**: write the new binding and save the
     session. Then print what follows:
     - a running Brain keeps acting for Ann until it restarts;
     - account sync will ask `account-sync data --merge|--replace` before it
       touches Bob's space (the `other-account` question);
     - the collaboration cursors for X are cleared.
3. Success prints `Signed in to <deployment> as <person> for account X (bound|already bound|rebound).`

`--switch-account` keeps its meaning: it forces the browser to re-authenticate. The
logout hint becomes "to sign in as someone else, use another `--account`, or
`--rebind` this one".

### `logto status [--account X] [--json]`

- Without `--account`: one row for each directory under `<home>/accounts/`. Each
  row shows the account, the deployment (official or issuer), the bound person,
  and the state: `signed in, expires …`, `signed out (bound to …)`,
  `sign-in in progress`, or `needs sign-in again`.
- With `--account`: the same row, plus the resource and org.
- `--json` emits the same fields, the way `host` commands do.

### `logto logout [--account X]`

This is today's flow for the one account: cancel the attempts, revoke, then remove
the tokens with compare-and-swap. `person.json` stays.

### `serve`

- It prints `serve: account X (from --account|COGNIA_LOCAL_ACCOUNT_ID|default)`
  and `serve: acts for <person> at <deployment>`. When X has no binding yet, it
  prints `not signed in`.
- It reads `person.json` **once at start** and passes the pinned person to both
  readers. A `--rebind` while the Brain is running takes effect at the next start.
  Mid-run identity changes were item 05.
- **Registry reconcile at start** (`UserBindingRegistry`):
  - no row: `bind`;
  - same person: nothing to do;
  - different person: `rebind`, which is the operator's explicit choice in
    `person.json`. Then clear `collab-notifications/X.json` and log
    `serve: account X now acts for Bob (was Ann)`.

  The Brain does the clearing itself, so a binding file deleted and re-created by
  hand is handled the same way.

### `account-sync … [--account X]`

Unchanged flags. The session comes from X. When X has no binding, the message is
`run cognia-agent logto login --account X`.

### `host login <name> --endpoint <url> [--account X] [--tenant t] [--fingerprint f]`

The invitation path is unchanged. When there is no invitation and the Host's auth
config is multi-tenant (`isMultiTenantAuthConfig`):

1. Read X's fresh session. When there is none, fail with a fix line built from the
   auth config:
   `cognia-agent logto login --account X --issuer <oidc.issuer> --client-id <oidc.nativeClientId> --resource <oidc.audience> --org <tenant>`.
2. The tenant is `--tenant` or the session's `organizationId`. They must agree,
   and one of them must exist.
3. Call `registerCompanionDevice({ mode: "oidc", oidc: { issuer, clientId, resource, organizationId, accessToken } })`.
4. The Host record keeps `account: X` and a person label, so `host show` says who
   paired. `host remove` revokes the device as it does today.
5. Remove the dead hint in `login.ts:68` and `pair-invitation.ts:75`.

`validateRegistrationContext` (`lib/tauri/companion-auth.ts:449`) accepts only
`webClientId`. The CLI signs in as the native client the config announces
(`oidc.nativeClientId`). The check widens to either announced client. The server
does not check the client: `register_handler` authenticates the bearer and takes
the tenant from its organization (`crates/cognia-companion/src/api.rs:1797`). The
desktop's own OIDC pairing goes through the same check, so whether it is a
sibling bug gets checked while building.

## Readers after the change

| Reader | Session | Person check |
| --- | --- | --- |
| `headlessSyncSession` | X's | the official issuer, and the token's `sub` must equal the pinned person (start of `serve`, or `person.json` for the `account-sync` command) |
| collaboration reader | X's | the token's `sub` and issuer must equal the pinned person. An official-account session is refused with "account X is signed in to the Cognia account, which has no collaboration server" |
| `host login` (OIDC) | X's | the issuer, resource and client must match the Host's auth config |

## Removed

- The single-file session paths and the per-home `logto-session` lock name.
- The two copies of the account default chain.
- The collaboration reader's "subject seen at start" (`collab-reader.ts:127`), now
  replaced by the pinned person.
- The `logto login` → `host add --kind device` hint.

## Tests (co-located)

- `cli/src/config/local-account.test.ts` (new): resolver precedence and sources,
  id encoding, refused ids.
- `cli/src/config/logto-session.test.ts`:
  - per-account paths;
  - two accounts do not share sessions or attempts;
  - `bindOnLogin` gives bound / same / mismatch / rebound;
  - logout keeps `person.json`;
  - the lock is per account.
- `cli/src/cli/logto-command.test.ts`:
  - a mismatch revokes the new tokens and keeps the old session;
  - `--rebind` prints what follows;
  - status lists all accounts and every state;
  - `--json`.
- `cli/src/account-sync/headless-sync.test.ts`: X's session only; refuses a person
  other than the pinned one.
- `cli/src/serve/collab-reader.test.ts`: the pinned person; refuses an
  official-account session.
- `cli/src/serve/serve-command.test.ts`:
  - the account source line;
  - registry reconcile gives bind / same / rebind, and a rebind clears the cursors;
  - a rebind while running does not change the running readers.
- `cli/src/cli/account-sync-command.test.ts`: the `--account` session and the
  unbound message.
- `cli/src/host/login.test.ts` and `cli/src/cli/host-command.test.ts`:
  - OIDC registration with the session;
  - the missing-session fix line comes from the config;
  - tenant agreement;
  - the record keeps `account`.
- `lib/tauri/companion-auth.test.ts`: the native client id is accepted, and an
  unknown client is refused.

## Docs, changeset, ADR

- `cli/README.md` (logto, serve, account-sync, host login).
- `docs/content/docs/{en,zh}/subsystems/official-account.mdx` and
  `account-sync-data.mdx`, which name `~/.cognia/logto.json`.
- ADR-0215's mentions of `logto.json`.
- ADR-0149 gets an implementation update: "The CLI: one sign-in per local account".
  No new ADR.
- Changeset `minor`: sign-in is per local account, existing installs sign in once
  more, and multi-tenant Hosts pair through `host login`.

## Out of scope

- Several provider accounts per provider id (item 09).
- Member partitions (`person-brain`). They never read the CLI session, because
  their person comes from the Host's member standing (ADR-0253).
- Deleting a local account's directory. Removing `<home>/accounts/<id>` by hand
  remains the way to do it.

## To check while building

- Whether an OIDC-registered device needs the person's token again later (for
  standing or suspension, ADR-0253), or only at registration.
- Whether the desktop's OIDC pairing hits the `webClientId`-only check (see
  `host login` above).
- Real browser runs against Logto and the official IdP, a live multi-tenant Host
  pairing, and two Hosts on one `COGNIA_HOME`. None of these can be covered by
  Jest.
