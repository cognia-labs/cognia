#!/usr/bin/env bash
# Agent CLIs for cognia-server's `runtime-full` image (ADR-0059 W6 / D9).
#
# The Runner images build the locked /cognia tree instead (deploy/runner/
# Dockerfile). The server still installs globally under /usr/local: it runs
# its Agents inside bubblewrap, whose read-only roots are the system
# directories, and moving it onto the locked tree is the plan's P3
# (docs/plans/2026-11-20-runner-full-locked-install.md). Versions are exactly
# the master bundle pins (deploy/bundle/npm/package.json); the global install
# does not carry the lock's transitive pins.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_json="${COGNIA_AGENT_PACKAGE_JSON:-${script_dir}/../bundle/npm/package.json}"
pins_json="${COGNIA_AGENT_PINS_JSON:-${script_dir}/../bundle/agent-versions.json}"

# Every master-pinned npm package at its exact version. A command substitution,
# not a pipe, so a refused pin stops the script under `set -e`.
package_specs="$(node -e '
  const deps = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).dependencies;
  const specs = [];
  for (const [name, version] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      console.error("install-agents: " + name + " requires an exact version, found " + version);
      process.exit(1);
    }
    specs.push(name + "@" + version);
  }
  process.stdout.write(specs.join(" "));
' "$package_json")"
read -r -a packages <<<"$package_specs"
: "${INSTALL_KIRO_CLI:=1}"
: "${INSTALL_DROID_CLI:=1}"

npm install -g --ignore-scripts --no-audit --no-fund "${packages[@]}"

# npm 11 requires an explicit script policy, including global rebuilds.
# Rebuild only the two native launcher installers owned by the master pins;
# transitive package scripts stay disabled rather than receiving blanket trust.
allowed_scripts=()
while IFS= read -r package; do
  allowed_scripts+=("$package")
done < <(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); for(const name of Object.keys(p.installScripts ?? {})) console.log(name)' "$pins_json")
if [ "${#allowed_scripts[@]}" -gt 0 ]; then
  allow_policy="$(IFS=,; printf '%s' "${allowed_scripts[*]}")"
  npm rebuild -g --foreground-scripts --allow-scripts="$allow_policy" "${allowed_scripts[@]}"
fi

# Kiro and Droid publish immutable assets with master-pinned SHA256 values.
# Fail the build on a failed verification or download.
install_vendor() {
  local runtime="$1" kind="$2" arch artifact url checksum executable
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "install-agents: unsupported architecture $(uname -m)" >&2; return 1 ;;
  esac
  url="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(p.runtimes.find(r=>r.id===process.argv[2])[process.argv[3]].assets["glibc-"+process.argv[4]].url)' "$pins_json" "$runtime" "$kind" "$arch")"
  checksum="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(p.runtimes.find(r=>r.id===process.argv[2])[process.argv[3]].assets["glibc-"+process.argv[4]].sha256)' "$pins_json" "$runtime" "$kind" "$arch")"
  artifact="$(mktemp)"
  curl -fsSL "$url" -o "$artifact"
  printf '%s  %s\n' "$checksum" "$artifact" | sha256sum -c -
  mkdir -p "/opt/cognia/vendor/$runtime"
  if [ "$kind" = archive ]; then
    tar -xzf "$artifact" -C "/opt/cognia/vendor/$runtime"
    executable="$(find "/opt/cognia/vendor/$runtime" -type f -name "$runtime" -print -quit)"
    test -n "$executable"
  else
    executable="/opt/cognia/vendor/$runtime/$runtime"
    cp "$artifact" "$executable"
  fi
  chmod -R a+rX "/opt/cognia/vendor/$runtime"
  chmod a+x "$executable"
  ln -sf "$executable" "/usr/local/bin/$runtime"
  "$executable" --version
  rm -f "$artifact"
}

if [ "${INSTALL_KIRO_CLI}" = "1" ]; then install_vendor kiro-cli archive; fi
if [ "${INSTALL_DROID_CLI}" = "1" ]; then install_vendor droid binary; fi

# Keep old ACP npx package names working through the canonical frozen binary.
# The server Dockerfile copies the adapter; standalone script users may
# retain native npm's dispatch by omitting it.
shim_script="${COGNIA_AGENT_SHIM_SCRIPT:-${script_dir}/install-selected.mjs}"
if [ -f "$shim_script" ]; then
  COGNIA_GLOBAL_NODE_MODULES="$(npm root -g)" node "$shim_script" install-full "$pins_json" "$package_json"
fi

npm cache clean --force
