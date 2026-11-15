# Example Tracker issue sync

Author reference plugin, copy-paste template, not a default. Requires the
`example-auth-provider` plugin's `auth.example-tracker` service (`^1.0.0`).

Run `/example-issues-connect` to select a connection and approve
`issues.request.GET`. `defineIssueSyncProvider` contributes a read-only issue
source with schema v2: `projectKey` and an open/closed status mapping.
The Host owns bindings, reconciliation and stored issues; the plugin uses
`ctx.integrations.authenticatedRequest` without reading tokens. Incomplete or
malformed pages fail before reconciliation can advance its watermark.

Replace the fictional `.test` service endpoints before use. Build with
`node plugins/example-issue-sync/build.mjs` and install its `dist/` ZIP manually.
The co-located tests exercise real Host resource resolution, issue import, grant
revocation and provider unavailability. `node
plugins/example-issue-sync/build.test.mjs` checks packaging against the built SDK.
