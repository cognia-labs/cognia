# Managed desktop release pin (ADR-0233 amendment A2)

Signed desktop builds bundle this directory, and `deploy/docker/Dockerfile.cognia-server`
copies it to `/usr/share/cognia/managed-desktop/`. The Host loads
`managed-desktop-release.json` from here when its data directory has none.

No pin means managed desktops stay dormant in that build; status, deletion and
cleanup still work.

To pin a release:

1. Publish the image from the revision you want: dispatch the Images workflow with
   `push: true`. Its `managed-desktop-release` artifact holds
   `managed-desktop-release.json` and `managed-desktop-release.source.json`.
2. Download the artifact and run
   `node scripts/build/managed-desktop-release.mjs --pin <artifact-dir>`.
   It refuses an artifact built from guest sources other than this tree's.
3. Commit both files.

`pnpm audit:managed-desktop-release` fails once the guest sources the pin was built
from change: publish the image again and re-pin it.
