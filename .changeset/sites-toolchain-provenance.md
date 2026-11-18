---
"cognia-next": patch
---

Sites builds now check the Node and package-manager versions inside the build sandbox before drafting a version, fail when the requested major is not the one that runs, and show the measured toolchain on each version. Next.js, SvelteKit and Remix projects are labelled as deployable only as a static export, and the Sites console on a paired device says it shows that device's own Sites rather than the Host's.
