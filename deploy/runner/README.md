# Runner Agent profiles

The legacy Docker/Kubernetes execution backend runs its configured command in
`COGNIA_RUNNER_IMAGE`. It does not inject an Agent bundle. The sandbox pool is
a separate path: it admits a project environment, injects the deployment's
digest-pinned bundle, probes the image, and resolves commands against the probe.
Changing only the Runner image does not change the pool's bundle.

## Build selected Agents

Build from the repository root. Runtime IDs come from
[`agent-versions.json`](../bundle/agent-versions.json), not display names:

```bash
docker build -f deploy/runner/Dockerfile --target selected \
  --build-arg AGENT_RUNTIMES=codex-app-server,codex-acp \
  -t cognia-runner:codex .
node deploy/runner/smoke.mjs cognia-runner:codex codex
```

`AGENT_RUNTIMES` accepts comma-separated available runtime IDs, `full`/`all`,
or `none`. Empty, unknown and unavailable selections fail the build. Ordering
is canonicalized and duplicates are removed. `none` retains execution tools
and Node, but no bundled Agent CLI.

Claude ACP includes Claude Code; Pi includes Pi ACP. OpenCode's two runtime
surfaces share a command. The build preserves the exact transitive lock,
including private nested CLI versions; it does not flatten those dependencies.

Selected builds derive their dependency roots, install-script allowlist,
verified downloads and shims from the same selected set. Known Agent `npx`
invocations resolve to installed frozen shims. Missing Agents are refused;
there is no startup installation. Project `npx` tools may use local dependencies
through native npm in offline mode, when the base provides npm.
Empty or mutable Agent version tags are refused. Arguments after the package
name are forwarded to the Agent or project tool.

## Custom toolchain image

For the legacy Runner, customize the Debian/glibc base at build time:

```bash
docker build -f deploy/runner/Dockerfile --target selected \
  --build-arg RUNTIME_IMAGE=python:3.12-slim \
  --build-arg AGENT_RUNTIMES=codex-app-server,codex-acp \
  -t cognia-runner:python-codex .
```

This path requires a Debian-derived image with `apt-get`, a compatible
architecture and glibc. It brings its own pinned Node and checks the base.
Native `npx` is detected in the final toolchain base, including installations
outside `/usr/local/bin`. Bases without npm still run selected Agent shims.
The image's entrypoint is cleared and the Agent runs as uid/gid 10001 with
`HOME=/home/cognia`. That is the uid cognia-server creates workspaces as, the
uid the sandbox pool's container tier uses, and the non-root user a
Kubernetes Restricted namespace admits. A base that already defines uid or
gid 10001 keeps its entries. Tools the base installs under `/root` are not
reachable by that user. Existing backend isolation controls still apply. The
original base's entrypoint/service is not run.

The Runner carries Agent CLIs, Git, curl and CA certificates, not project
toolchains. A project that needs Python, Rust or another toolchain either
builds a Runner on that base as shown above or, preferably, names its own
image through the sandbox pool, which injects the Agent bundle into it
(ADR-0182, ADR-0183).

Selection applies to the Cognia payload; software supplied by `RUNTIME_IMAGE`
stays in the image. Choose a minimal base to control the complete installed
Agent set.

Set the resulting image through the deployment's existing configuration:

```dotenv
COGNIA_RUNNER_IMAGE=registry.example/cognia-runner@sha256:<digest>
```

For the sandbox pool, choose the project toolchain image using the existing
Image catalog or approved environment declaration. Configure the selected
bundle separately through `COGNIA_AGENT_BUNDLE_IMAGE`, or the baseline file's
bundle policy. A baseline file takes precedence over the legacy environment
mapping. Registry allowlists, image/bundle digests, approval, isolation and
probe requirements continue to apply. Image-baked CLIs do not override the
bundle's command resolution.

## Full compatibility

```bash
docker build -f deploy/runner/Dockerfile --target full \
  -t cognia-runner:full .
```

The final default target and existing unsuffixed release tags remain Full.
CI also publishes explicit `latest-full` and selected `latest-codex` aliases,
only after their image smoke tests pass. `latest*` tags move on stable release
tags only (`v2.1.0`, never `v2.1.0-beta.1`); a prerelease gets its version tag.
Every pushed image carries SBOM and max-level provenance attestations
(`docker buildx imagetools inspect <image> --format '{{ json .SBOM }}'`).
Runner images are published for `linux/amd64` only. On an ARM host, build
the target you need from this Dockerfile; the Agent bundle the sandbox pool
injects is published for both `linux/amd64` and `linux/arm64`.

Full retains the legacy Agent set. Cline is bundled like the other npm
runtimes, for glibc only because its native binary links glibc, so a
selected build can name it (`AGENT_RUNTIMES=cline`). Full's npm Agent
versions default to the shared exact pins; version overrides must also be
exact. Kiro and Droid use
checksum-verified pinned assets. Full's global npm install retains
compatibility behavior and does not provide the selected path's
transitive-lock guarantee.

Cursor is not installed by default. Its vendor installer publishes no
checksum and changes without notice, so it runs only when the build asks for
it with `--build-arg INSTALL_CURSOR_AGENT=1`. A failed install then fails the
build. It is unavailable in selected builds.

These pins do not change Cognia's runtime certification catalog. Smoke checks
run offline without model requests: CLI startup, unauthenticated ACP
initialization (Codex ACP and, in Full, Cline), the Codex app-server
`initialize` handshake, and a workspace write as the Runner's user. They do
not certify authenticated provider calls.
