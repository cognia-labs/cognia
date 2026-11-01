# Example Tracker backup destination

Author reference plugin, copy-paste template, not a default. Requires the
`example-auth-provider` plugin's `auth.example-tracker` service (`^1.0.0`).

Run `/example-backups-connect` and approve `backups.request.GET` plus
`backups.request.PUT`. `defineBackupDestination` contributes readiness, upload,
list and download. The Host packages and encrypts backups first. The destination
base64-encodes opaque ciphertext for its JSON protocol; it never receives a
passphrase or plaintext and never sees a connection token. Upload streams honor
cancellation. All requests use `ctx.integrations.authenticatedRequest`.

Replace the fictional `.test` endpoints before real use. Build with `node
plugins/example-backup-destination/build.mjs` and install its `dist/` ZIP manually.
The co-located tests round-trip a Host-encrypted backup, reject plaintext at Host
dispatch, exercise stream cancellation, and verify grant revocation and provider
unavailability. `node plugins/example-backup-destination/build.test.mjs` checks
packaging against the built SDK package.
