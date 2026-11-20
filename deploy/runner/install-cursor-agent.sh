#!/usr/bin/env bash
# Opt-in Cursor CLI for the Full runner (`--build-arg INSTALL_CURSOR_AGENT=1`).
#
# Cursor has no npm distribution and publishes no checksum, so it cannot join
# the master lock and its vendor installer is mutable. It therefore runs only
# when the build asks for it, and a failed install fails that build instead of
# shipping an image without it.
#
# The installer drops `cursor-agent` under $HOME/.local. Give it a home of its
# own in /opt, not /root: /root is 0700 and the runner's agents run as uid
# 10001.
set -euo pipefail

cursor_home="${COGNIA_CURSOR_HOME:-/opt/cognia/vendor/cursor-agent}"
bin_dir="${COGNIA_CURSOR_BIN_DIR:-/usr/local/bin}"

mkdir -p "$cursor_home"
curl -fsSL https://cursor.com/install | HOME="$cursor_home" bash
test -x "$cursor_home/.local/bin/cursor-agent"
chmod -R a+rX "$cursor_home"
ln -sf "$cursor_home/.local/bin/cursor-agent" "$bin_dir/cursor-agent"
"$bin_dir/cursor-agent" --version
