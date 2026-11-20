# syntax=docker/dockerfile:1.7
FROM node:26-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v1.63.0-noble
# Keep the browser image and playwright-core aligned while honoring engines.node.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
    COGNIA_WORKSPACE_ROOT=/workspace \
    COGNIA_BROWSER_PROFILES_ROOT=/profiles \
    COGNIA_BROWSER_OVERLAY_PATH=/opt/cognia-runtime/src/overlay.injected.js \
    COGNIA_WORKSPACE_RUNTIME_PORT=27910

# The Playwright base ships its own Node. Install the repository's pinned pnpm
# (`packageManager` in package.json) explicitly instead of relying on the
# base's Corepack, whose bundled signing keys have lagged the registry before.
ARG PNPM_VERSION=11.18.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /opt/cognia-runtime
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /opt/cognia-runtime-root/
COPY patches /opt/cognia-runtime-root/patches
COPY services/workspace-runtime/package.json /opt/cognia-runtime-root/services/workspace-runtime/package.json
RUN cd /opt/cognia-runtime-root \
    && pnpm install --filter @cognia/workspace-runtime --prod --frozen-lockfile --ignore-scripts \
    && ln -s /opt/cognia-runtime-root/services/workspace-runtime/node_modules /opt/cognia-runtime/node_modules

COPY services/workspace-runtime/src ./src
COPY lib/browser/overlay.injected.js ./src/overlay.injected.js
COPY services/workspace-runtime/entrypoint.sh /usr/local/bin/cognia-workspace-runtime
# The runtime runs as uid/gid 10001 (`cognia`), the uid cognia-server creates
# workspaces as and the Runner image runs as, so all three can write the
# shared workspace (deploy/compose/README.md). The entrypoint starts as root
# only to hand the mounts to that user.
RUN chmod 0755 /usr/local/bin/cognia-workspace-runtime \
    && groupadd --gid 10001 cognia \
    && useradd --uid 10001 --gid 10001 --home-dir /home/cognia --create-home \
        --shell /usr/sbin/nologin cognia \
    && install -d -o 10001 -g 10001 /workspace /profiles
# Docker exports the image user's HOME (root's) unless the image sets one, and
# gosu keeps an inherited HOME, so the runtime and the Agents it starts would
# otherwise get /root. Set after the build steps, whose caches stay root's.
ENV HOME=/home/cognia

EXPOSE 27910
ENTRYPOINT ["/usr/local/bin/cognia-workspace-runtime"]
