# syntax=docker/dockerfile:1.7
# cognia-runner — one external Agent per container (ADR-0059 T2 / D9).
#
# Build from the REPOSITORY ROOT:
#   docker build -f deploy/runner/Dockerfile --target selected \
#     --build-arg AGENT_RUNTIMES=codex-app-server -t cognia-runner:codex .
#   docker build -f deploy/runner/Dockerfile --target full -t cognia-runner:full .
# The default final target remains Full for existing callers. New deployments
# can choose selected; all/full includes every verified distributable runtime,
# none includes only the execution base. Full is that `full` selection, built
# by the same locked steps, plus project npx online; the unverified Cursor
# installer runs only with INSTALL_CURSOR_AGENT=1.
#
# Both targets run as uid/gid 10001 (`cognia`, HOME=/home/cognia): the uid
# cognia-server owns the workspace tree as and the sandbox pool's container
# tier runs agents as, and the non-root user a Kubernetes Restricted namespace
# admits.
#
# RUNTIME_IMAGE customizes the project/toolchain base. Supported custom bases
# are Debian-derived glibc images with apt-get; selected brings pinned Node.
ARG NODE_VERSION=26.12.1
ARG RUNTIME_IMAGE=node:26.12.1-bookworm-slim

# The pinned Agent tree under /cognia: npm ci from the master lock pruned to a
# selection, checksum-verified vendor binaries, and frozen shims. Selected and
# Full run the same steps and differ only in the selection and the npx mode.
FROM node:${NODE_VERSION}-bookworm-slim AS agent-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates patchelf libatomic1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY deploy/bundle/agent-versions.json deploy/bundle/Dockerfile ./deploy/bundle/
COPY deploy/bundle/npm/package.json deploy/bundle/npm/package-lock.json ./deploy/bundle/npm/
COPY scripts/build/bundle-agent-versions.mjs ./scripts/build/bundle-agent-versions.mjs
COPY protocol/external-agent-runtimes.json ./protocol/external-agent-runtimes.json
COPY crates/cognia-sandboxd/src/layout.rs ./crates/cognia-sandboxd/src/layout.rs

FROM agent-build AS selected-build
ARG TARGETARCH
ARG AGENT_RUNTIMES=codex-app-server
RUN node scripts/build/bundle-agent-versions.mjs prepare --root /build \
      --runtimes "$AGENT_RUNTIMES" --out /selection
RUN mkdir -p /cognia/glibc/lib/agents \
    && cp /selection/npm/package*.json /cognia/glibc/lib/agents/ \
    && cd /cognia/glibc/lib/agents \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Dispatcher-only changes should reuse the selected dependency installation.
COPY deploy/runner/install-selected.mjs ./deploy/runner/install-selected.mjs
RUN node scripts/build/bundle-agent-versions.mjs stage --pins /selection/agent-versions.json \
      --libc glibc --arch "$TARGETARCH" --tree /cognia/glibc \
    && node deploy/runner/install-selected.mjs install \
      /selection/agent-versions.json /selection/npm/package.json \
      /build/deploy/bundle/npm/package.json /build/deploy/bundle/agent-versions.json

FROM agent-build AS full-build
ARG TARGETARCH
RUN node scripts/build/bundle-agent-versions.mjs prepare --root /build \
      --runtimes full --out /selection
RUN mkdir -p /cognia/glibc/lib/agents \
    && cp /selection/npm/package*.json /cognia/glibc/lib/agents/ \
    && cd /cognia/glibc/lib/agents \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Dispatcher-only changes should reuse the selected dependency installation.
COPY deploy/runner/install-selected.mjs ./deploy/runner/install-selected.mjs
RUN node scripts/build/bundle-agent-versions.mjs stage --pins /selection/agent-versions.json \
      --libc glibc --arch "$TARGETARCH" --tree /cognia/glibc \
    && node deploy/runner/install-selected.mjs install-compat \
      /selection/agent-versions.json /selection/npm/package.json \
      /build/deploy/bundle/npm/package.json /build/deploy/bundle/agent-versions.json

FROM ${RUNTIME_IMAGE} AS base
USER root
# The agent runs as 10001, never root. cognia-server creates the workspace
# tree as uid 10001 (deploy/docker/Dockerfile.cognia-server) and the backend
# drops every capability, so root here would hold no CAP_DAC_OVERRIDE and
# could not write a 10001-owned 0755 directory anyway. A custom base that
# already has uid 10001 or gid 10001 keeps its entries; HOME is set below
# either way.
RUN test -f /etc/debian_version \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && { getent group 10001 >/dev/null || groupadd --gid 10001 cognia; } \
    && { getent passwd 10001 >/dev/null \
         || useradd --uid 10001 --gid 10001 --home-dir /home/cognia --no-create-home --shell /bin/bash cognia; } \
    && mkdir -p /home/cognia /workspace \
    && chown 10001:10001 /home/cognia /workspace
WORKDIR /workspace
ENTRYPOINT []
CMD ["bash"]

FROM base AS selected
COPY --from=selected-build /cognia /cognia
# Resolve project npm from the actual custom base before adding our wrapper
# to PATH; Debian npm and custom toolchains need not use /usr/local/bin.
RUN COGNIA_NATIVE_NPX="$(command -v npx || true)" \
      /cognia/glibc/node/bin/node /cognia/runner/install-selected.mjs configure-base \
      /cognia/runner/agent-selection.json
ENV PATH="/cognia/runner/bin:/cognia/glibc/bin:/cognia/glibc/node/bin:${PATH}" \
    HOME=/home/cognia
USER 10001:10001
LABEL org.opencontainers.image.title="cognia-runner-selected" \
      org.opencontainers.image.description="Selected exact-version Agent runtimes; no npx download fallback"

FROM base AS full
# Every distributable runtime from the master lock, the same tree a selected
# build gets; the npx dispatcher keeps Full's online native npx for project
# tools. Versions come only from the pins: change them there and regenerate
# the lock (deploy/bundle/README.md).
COPY --from=full-build /cognia /cognia
# Cursor publishes no checksum for its CLI, so its mutable installer is opt-in.
ARG INSTALL_CURSOR_AGENT=0
COPY deploy/runner/install-cursor-agent.sh /tmp/install-cursor-agent.sh
RUN COGNIA_NATIVE_NPX="$(command -v npx || true)" \
      /cognia/glibc/node/bin/node /cognia/runner/install-selected.mjs configure-base \
      /cognia/runner/agent-selection.json \
    && if [ "$INSTALL_CURSOR_AGENT" = "1" ]; then bash /tmp/install-cursor-agent.sh; fi \
    && rm -f /tmp/install-cursor-agent.sh
ENV PATH="/cognia/runner/bin:/cognia/glibc/bin:/cognia/glibc/node/bin:${PATH}" \
    HOME=/home/cognia
USER 10001:10001
LABEL org.opencontainers.image.title="cognia-runner-full" \
      org.opencontainers.image.description="Every distributable Agent runtime from the master lock; Cursor only when built with INSTALL_CURSOR_AGENT=1"
