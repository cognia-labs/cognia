# Feishu Authentication

`feishu-user-oauth` is a Host-managed provider of `auth.feishu` at exactly
`1.0.0`. Its stable provider id is retained for existing connections and
calendar configuration. The plugin builds requests and describes identities;
the Host owns tokens, callback acceptance, refresh locks, credential revisions,
logout tombstones and app secrets. There is no plugin token store or scheduler.

## Setup

Choose the deployment (`https://accounts.feishu.cn` or
`https://accounts.larksuite.com`) in the Host configuration form. Enter your own
App ID and App Secret. `authorization.clientIdFrom.configuration = "appId"`
resolves the App ID from `AuthSessionOptions.configuration`; the Host writes the
secret under the plugin, provider, App ID and issuer and never supplies it to
plugin callbacks or plugin settings. Leave the secret empty to reuse that
client's stored secret. No placeholder App ID is bundled.

- **User:** authorization code with S256 PKCE; consent must include
  `offline_access` and the requested business scopes. Register the exact callback
  URI in the developer console. The default is the Host callback for the runtime;
  a hosted HTTPS `/plugin-auth/callback` page may also be configured (HTTP only
  for localhost). The generic Host acceptor handles deep links, messages and
  broadcast delivery, single use, expiry and cancellation.
- **Bot:** client credentials at `tenant_access_token/internal`, followed by
  `tenant/v2/tenant/query`. Grant **`tenant:tenant:readonly`** to the app. Tenant
  query failure prevents connection; neither the app id nor any other value is
  used as a guessed tenant. The bot principal id is the App ID, and its tenant
  id is the returned `tenant_key`. Refresh re-exchanges client credentials.

Both grants and user refresh use `ctx.auth.exchangeConfidential` (`auth:exchange`);
the Host injects credentials. The manifest permits only the exact POST token
paths and GET identity paths for both deployments. Confidential exchange needs
a trusted desktop or always-on Host. Browser/mobile are degraded until one is
connected; headless supports bot setup and existing users, while initial user
consent needs an interactive shell.

A built-in Lark connection for the same issuer, App ID and principal owns the
existing lineage. Connecting this plugin is refused with
`ConnectionIdentityConflict`; disconnect or use that connection first.

Feishu has no documented generic revocation endpoint. Disconnect therefore
writes a local tombstone; revoke app consent in Feishu/Lark to invalidate the
remote grant. The plugin supplies no pretend remote revoke callback.

## Existing sessions and calendar transition

The Host built-ins list registers a migrator keyed by the plugin and provider
ids. Generic connect and session paths dispatch through that registry. At
registration the Host migrates `plugin:feishu-auth` `oauth-session:*` records.
Each app secret moves to its own client/issuer slot before exchange. Identity
comes from `describe`; old stored open ids provide recovery metadata if remote
identity cannot be read. Missing refresh tokens and rejected/interrupted grants
become `needs-reauth`, with no guessed tenant. Reauthentication can fill the
unknown tenant after matching the issuer, app and stored user identity. The
encrypted Host migration ledger checkpoints credentials until handover, then
keeps completion evidence independently of audit pruning; the old plugin record
is deleted only after durable Host storage. Retrying a
completed migration does not exchange again. An interrupted exchange is never
blindly replayed. A known legacy identity already owned by built-in Lark is
refused before refresh; its original record is retained for explicit recovery.

Until P5c, the Host adapter still serves `getSessions`/`getSession`, preserves old
session ids as aliases, and accepts calendar's legacy `clientId` form field as
an alias for `appId`. Calendar retains its current dependency and provider id.
P5c must move its auth strategy and stored integration accounts to connection
references and consumer grants, declare `requiresServices: {"auth.feishu":
"^1.0.0"}`, and remove its App Secret form. Its API origin is still Feishu-only;
Lark calendar support requires its own deployment-aware API changes in P5c.
The P5d PII exemption removal is separate.

## Validation and distribution

Tests exercise the Host connect/callback/connection path, identity, bot tenant
query, revision-only rotation, invalid grants, duplicate refusal against actual
built-in Lark reconciliation, per-client migration, and legacy session access.
They exercise the actual calendar client and legacy credential injection with a
migrated session handle. They stub remote responses and do not prove live
consent or native keychain acceptance.

Source and manifest changes require regenerating bundled plugin artifacts with
`node scripts/plugin/artifacts/produce.mjs --out <dir>` before release. That
producer is intentionally not run in this change. Author declarations are
regenerated separately with `node scripts/plugin/generate-author-types.mjs`.

## Protocol sources

- https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
- https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
- https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token
- https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get
- https://open.feishu.cn/document/server-docs/tenant-v2/query
