#!/bin/sh
set -eu

# Root only long enough to hand the mounts to the runtime's user, uid/gid
# 10001: the uid cognia-server creates workspaces as and the Runner runs as,
# so all three can write the shared workspace. A fresh volume or PVC arrives
# root-owned. Only the workspace directory itself is taken, because the files
# in it belong to cognia-server and the runners too. The profiles volume is the
# runtime's alone, so anything an earlier image left there under another uid
# is taken over as well.
RUNTIME_USER=10001:10001
install -d -o 10001 -g 10001 /workspace /profiles
chown "$RUNTIME_USER" /workspace /profiles
find /profiles -xdev \( ! -user 10001 -o ! -group 10001 \) -exec chown -h "$RUNTIME_USER" {} +
if [ -n "${COGNIA_WORKSPACE_ID:-}" ] && [ -n "${COGNIA_WORKSPACE_RUNTIME_SECRET:-}" ] && [ -d /runtime-secrets ]; then
  case "$COGNIA_WORKSPACE_ID" in
    *[!A-Za-z0-9._-]*|'') echo "invalid COGNIA_WORKSPACE_ID" >&2; exit 64 ;;
  esac
  umask 077
  printf '%s' "$COGNIA_WORKSPACE_RUNTIME_SECRET" > "/runtime-secrets/$COGNIA_WORKSPACE_ID"
  chmod 0444 "/runtime-secrets/$COGNIA_WORKSPACE_ID"
fi
exec gosu "$RUNTIME_USER" node /opt/cognia-runtime/src/main.mjs
