# Example Sync

An intentionally unbundled frontend reference for `ctx.sync`, using only the
public `@cognia/plugin-sdk`. It has no Node engine requirement or network calls.

Activation registers `demo` and requests a poll. The fictional remote yields
two full pages and an opaque terminal cursor; later incremental runs yield no
changes. The Host retains the cursor, retry state and generation. Plugin storage
retains a small mirror; full reconciliation marks absent items `sourceRemoved`
without deleting them. Disabling the plugin disposes its registration.

For a real service, replace `fetchRemote` with a consumer-granted integration
request, bind its immutable connection through `ctx.sync.register(key, driver, { connectionRef })`, and use `syncRateLimited`
or `syncCursorInvalid` for provider retry and cursor invalidation signals.

The co-located test drives the public plugin through the real Host API and
IndexedDB sync core. It does not contact a provider.
