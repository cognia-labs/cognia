# Example Tracker docs provider

Author reference plugin, copy-paste template, not a default. Requires the
`example-auth-provider` plugin's `auth.example-tracker` service (`^1.0.0`).

Run `/example-docs-connect` to select a Host connection and approve the
`docs.request.GET` consumer grant. `defineDocsProvider` registers a provider for
`https://docs.example-tracker.test/documents/<id>`. It fetches documents through
`ctx.integrations.authenticatedRequest` and never receives credentials.
Background reads do not prompt again after revocation. A disabled auth provider
leaves the required service waiting; existing connection metadata is retained.

The `.test` endpoints are fictional: replace them and configure the auth
provider before real use. Build with `node plugins/example-docs-provider/build.mjs`
and install its `dist/` ZIP manually. The co-located Host integration tests cover
sign-in, consent, URL recognition, document reads, revocation during a read and
provider disable/restore. `node plugins/example-docs-provider/build.test.mjs`
checks packaging against the built SDK package.
