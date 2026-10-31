# Feishu Authentication

Shared singleton authentication provider `feishu-user-oauth`. Consumers declare
`dependencies: { "feishu-auth": "^1.0.0" }`, reference the provider in their
Integration auth strategy, and send requests through `authenticatedRequest`.
They do not import this plugin's source or read its credential storage.

This is a provider plugin rather than a `library.modules` module: library modules
are instantiated with each consumer's context and would duplicate account state.
Pure request-building utilities may be library modules; shared login is a
provider-owned service.

## Setup

Use a Feishu custom application enabled for the requested user scopes. The
consumer's account form supplies `clientId`, `clientSecret`, and `redirectUri`.
Register the exact redirect URI in the Feishu developer console. It must point
to the deployed Cognia static page `https://<your-host>/plugin-auth/callback`;
HTTP is accepted only for localhost development. This plugin does not start a
loopback HTTP server. After consent, click **Return to Cognia** on the callback
page to deliver the code to the running desktop app. State and S256 PKCE are
checked; the callback URI must not have query parameters or a fragment.

The provider adds `offline_access` and requires all requested scopes to be
actually granted. Sessions, app credentials, access/refresh tokens, expiry, and
rotating refresh tokens are persisted only through `ctx.secrets`. Refreshes are
single-flight per session. Account IDs include the application ID because
Feishu open IDs are app-specific.

Removing a session deletes local credentials. Feishu's v2 OAuth documentation
does not define a generic token-revocation endpoint; revoke the application's
consent from Feishu's authorized-app settings to invalidate it remotely. Plugin
disable stops pending authorization and removes its provider, while preserving
encrypted credentials for re-enable.

Interactive authentication currently supports the desktop host. Browser,
mobile and headless startup are declared unsupported rather than exposing a
confidential app secret or pretending a callback listener exists.

## Protocol sources

- https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
- https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token
- https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token
- https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get

Real consent, keychain and native callback delivery require a configured Feishu
application and an installed desktop build. Unit tests cover protocol and
lifecycle behavior but do not establish real-provider acceptance.
