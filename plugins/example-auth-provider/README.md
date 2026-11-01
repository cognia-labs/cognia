# Example Tracker auth provider

Author reference plugin, copy-paste template, not a default. This fictional
service uses reserved `.test` domains; replace them and the public client ID
with your own service configuration before use.

`defineAuthProvider` uses `management: "host"`: the Host creates PKCE attempts,
accepts callbacks once, stores connections and credentials, and coordinates
refresh and rotation. Exchange and refresh call `ctx.auth.exchangeConfidential`
through `auth:exchange` with `placement: "none"`. No client secret or token
storage lives in the plugin. Only the provider's `describe` callback reads
credentials to identify the user. It provides `auth.example-tracker` at `1.0.0`.

Build with `node plugins/example-auth-provider/build.mjs`; install the ZIP from
its `dist/` directory manually. Install one of the three consumer examples to
trigger sign-in. Browser/mobile exchange requires a connected trusted Host;
headless can reuse a connection established interactively.

`src/index.test.ts` exercises real Host auth, callback acceptance, credential
storage and refresh, with fictional network peers. `node
plugins/example-auth-provider/build.test.mjs` checks the standalone ZIP against
the built SDK package. Run the SDK package build first after changing it.
